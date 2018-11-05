/**
 * Cloud Formation Module.  Handles stack creation, deletion, and updating.  Adds
 * periodic polling to check stack status.  So that stack operations are
 * synchronous.
 */

const filesystem = require('fs')

const Promise = require('bluebird')
const YAML = require('yamljs')
const AWS = require('aws-sdk')
const _ = require('lodash')
const sprintf = require('sprintf')
const moment = require('moment')
const flow = require('lodash/fp/flow')
const keyBy = require('lodash/fp/keyBy')
const get = require('lodash/fp/get')
const mapValues = require('lodash/fp/mapValues')
const merge = require('lodash/merge')
const chalk = require('chalk')
const HttpsProxyAgent = require('https-proxy-agent')

const fs = Promise.promisifyAll(filesystem)
AWS.config.setPromisesDependency(Promise)

const PROXY = process.env.PROXY || process.env.https_proxy || process.env.http_proxy

const ONE_MINUTE = 60000

const success = [
  'CREATE_COMPLETE',
  'DELETE_COMPLETE',
  'UPDATE_COMPLETE'
]

const failed = [
  'ROLLBACK_FAILED',
  'ROLLBACK_IN_PROGRESS',
  'ROLLBACK_COMPLETE',
  'UPDATE_ROLLBACK_IN_PROGRESS',
  'UPDATE_ROLLBACK_COMPLETE',
  'UPDATE_FAILED',
  'DELETE_FAILED'
]

const exists = [
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'ROLLBACK_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE'
]

const colorMap = {
  CREATE_IN_PROGRESS: 'gray',
  CREATE_COMPLETE: 'green',
  CREATE_FAILED: 'red',
  DELETE_IN_PROGRESS: 'gray',
  DELETE_COMPLETE: 'green',
  DELETE_FAILED: 'red',
  ROLLBACK_FAILED: 'red',
  ROLLBACK_IN_PROGRESS: 'yellow',
  ROLLBACK_COMPLETE: 'red',
  UPDATE_IN_PROGRESS: 'gray',
  UPDATE_COMPLETE: 'green',
  UPDATE_COMPLETE_CLEANUP_IN_PROGRESS: 'green',
  UPDATE_ROLLBACK_IN_PROGRESS: 'yellow',
  UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS: 'yellow',
  UPDATE_ROLLBACK_FAILED: 'red',
  UPDATE_ROLLBACK_COMPLETE: 'red',
  UPDATE_FAILED: 'red'
}

const ings = {
  create: 'Creating',
  delete: 'Deleting',
  update: 'Updating'
}

let _config = {
  checkStackInterval: 5000
}

function Cfn (name, template) {
  let log = console.log
  let opts = _.isPlainObject(name) ? name : {}
  let awsOpts = {}
  let startedAt = Date.now()
  let params = opts.params
  let cfParams = opts.cfParams || {}
  let awsConfig = opts.awsConfig
  let capabilities = opts.capabilities || ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM']
  let tags = opts.tags || {}
  let async = opts.async
  let checkStackInterval = opts.checkStackInterval || _config.checkStackInterval

  if (PROXY) {
    awsOpts.httpOptions = {
      agent: new HttpsProxyAgent(PROXY)
    }
  }
  if (awsConfig) {
    _.merge(awsOpts, awsConfig)
  }

  // initialize cf
  let cf = new AWS.CloudFormation(awsOpts)

  name = opts.name || name
  template = opts.template || template

  function checkStack (action, name) {
    const logPrefix = name + ' ' + action.toUpperCase()
    const notExists = /ValidationError:\s+Stack\s+\[?.+]?\s+does not exist/
    const throttling = /Throttling:\s+Rate\s+exceeded/
    let displayedEvents = {}

    return new Promise(function (resolve, reject) {
      let interval
      let running = false

      // on success:
      // 1. clear interval
      // 2. return resolved promise
      function _success () {
        clearInterval(interval)
        return resolve()
      }

      // on fail:
      // 1. build fail message
      // 2. clear interval
      // 3. return rejected promise with failed message
      function _failure (msg) {
        const fullMsg = logPrefix + ' Failed' + (msg ? ': ' + msg : '')
        clearInterval(interval)
        return reject(new Error(fullMsg))
      }

      function _processEvents (events) {
        events = _.sortBy(events, 'Timestamp')
        _.forEach(events, function (event) {
          displayedEvents[event.EventId] = true
          if (moment(event.Timestamp).valueOf() >= startedAt) {
            log(sprintf('[%s] %s %s: %s - %s  %s  %s',
              chalk.gray(moment(event.Timestamp).format('HH:mm:ss')),
              ings[action],
              chalk.cyan(name),
              event.ResourceType,
              event.LogicalResourceId,
              chalk[colorMap[event.ResourceStatus]](event.ResourceStatus),
              event.ResourceStatusReason || ''
            ))
          }
        })

        const lastEvent = _.last(events) || {}
        const timestamp = moment(lastEvent.Timestamp).valueOf()
        const resourceType = lastEvent.ResourceType
        const status = lastEvent.ResourceStatus
        const statusReason = lastEvent.ResourceStatusReason

        // Only fail/succeed on cloud formation stack resource
        // and ensure we are not finishing on a nested template
        if (resourceType === 'AWS::CloudFormation::Stack' && lastEvent.LogicalResourceId === name) {
          // if cf stack status indicates failure AND the failed event occurred during this update, notify of failure
          // if cf stack status indicates success, OR it failed before this current update, notify of success
          if (_.includes(failed, status) && (timestamp >= startedAt)) {
            _failure(statusReason)
          } else if (_.includes(success, status) || (_.includes(failed, status) && (timestamp < startedAt))) {
            _success()
          }
        }
        running = false
      }

      // provides all pagination
      function getAllStackEvents (stackName) {
        let next
        let allEvents = []

        function getStackEvents () {
          return cf.describeStackEvents({
            StackName: stackName,
            NextToken: next
          })
            .promise()
            .then(function (data) {
              next = (data || {}).NextToken
              allEvents = allEvents.concat(data.StackEvents)
              return next && !allRelevantEventsLoaded(data.StackEvents) ? getStackEvents() : Promise.resolve()
            })
        }
        return getStackEvents().then(function () {
          return allEvents
        })
      }

      // events are loaded sorted by timestamp desc (newest events first)
      // if we try to load all events we can easily run into throttling by aws api
      function allRelevantEventsLoaded (events) {
        return events.some(event => moment(event.Timestamp).valueOf() < startedAt)
      }

      function outputNewStackEvents () {
        let events = []

        if (running) {
          return
        }
        running = true

        return getAllStackEvents(name)
          .then(function (allEvents) {
            running = false
            _.forEach(allEvents, function (event) {
              // if event has already been seen, don't add to events to process list
              if (displayedEvents[event.EventId]) {
                return
              }
              events.push(event)
            })
            return _processEvents(events)
          }).catch(function (err) {
            // if stack does not exist, notify success
            if (err && notExists.test(err)) {
              return _success()
            }
            // if throttling has occurred, process events again
            if (err && throttling.test(err)) {
              log('AWS api calls are throttling')
              return _processEvents(events)
            }
            // otherwise, notify of failure
            if (err) {
              return _failure(err)
            }
          })
      }

      // call once and repeat in intervals
      outputNewStackEvents()
      interval = setInterval(outputNewStackEvents, checkStackInterval)
    })
  }

  function processCfStack (action, cfparms) {
    startedAt = Date.now()
    if (action === 'update') {
      return cf.updateStack(cfparms).promise()
        .catch(function (err) {
          if (!/No updates are to be performed/.test(err)) {
            throw err
          } else {
            log('No updates are to be performed.')
          }
        })
    }
    return cf.createStack(cfparms).promise()
  }

  function loadJs (path) {
    let tmpl = require(path)

    let fn = _.isFunction(tmpl) ? tmpl : function () {
      return tmpl
    }
    return Promise.resolve(JSON.stringify(fn(params)))
  }

  function normalizeParams (templateObject, params) {
    if (!params) return Promise.resolve([])
    if (!_.isPlainObject(params)) return Promise.resolve([])
    if (_.keys(params).length <= 0) return Promise.resolve([])

    // mutate params
    _.keys(params).forEach(k => {
      params[_.toLower(k)] = params[k]
    })
    return cf.getTemplateSummary(templateObject).promise()
      .then(data => {
        let templateParams = data.Parameters || []
        return templateParams.map(p => {
          let k = _.toLower(p.ParameterKey)
          let v = params[k]
          return {
            ParameterKey: p.ParameterKey,
            ParameterValue: v || p.DefaultValue
          }
        })
      })
  }

  function convertTags () {
    if (!_.isPlainObject(tags)) return []
    return (Object.keys(tags)).map(function (key) {
      return {
        Key: key,
        Value: tags[key]
      }
    })
  }

  function isStringOfType (type, str) {
    let result = true
    try {
      type.parse(str)
    } catch (ignore) {
      result = false
    }
    return result
  }

  function isJSONString (str) {
    return isStringOfType(JSON, str)
  }

  function isYAMLString (str) {
    return isStringOfType(YAML, str) && str.split(/\r\n|\r|\n/).length > 1
  }

  function isValidTemplateString (str) {
    return isJSONString(str) || isYAMLString(str)
  }

  function templateBodyObject (template) {
    return {
      TemplateBody: template
    }
  }

  function processTemplate (template) {
    // Check if template is located in S3
    if (isUriTemplate(template)) return Promise.resolve({TemplateURL: template})

    // Check if template if a `js` file
    if (_.endsWith(template, '.js')) return loadJs(template).then(templateBodyObject)

    // Check if template is an object, assume this is JSON good to go
    if (_.isPlainObject(template)) return Promise.resolve(template).then(flow(JSON.stringify, templateBodyObject))

    // Check if template is a valid string, serialised json or yaml
    if (isValidTemplateString(template)) return Promise.resolve(templateBodyObject(template))

    // Default to loading template from file.
    return fs.readFileAsync(template, 'utf8').then(templateBodyObject)
  }

  function isUriTemplate (template) {
    const httpsUri = /https:\/\/s3.+amazonaws.com/
    return httpsUri.test(template)
  }

  function processStack (action, name, template) {
    return processTemplate(template)
      .then(templateObject => {
        return normalizeParams(templateObject, cfParams)
          .then(noramlizedParams => {
            return processCfStack(action, merge({
              StackName: name,
              Capabilities: capabilities,
              Parameters: noramlizedParams,
              Tags: convertTags()
            }, templateObject))
          })
      })
      .then(function () {
        return async ? Promise.resolve() : checkStack(action, name)
      })
  }

  this.stackExists = function (overrideName) {
    return cf.describeStacks({ StackName: overrideName || name }).promise()
      .then(function (data) {
        return _.includes(exists, data.Stacks[0].StackStatus)
      })
      .catch(function () {
        return false
      })
  }

  this.createOrUpdate = function () {
    return this.stackExists()
      .then(function (exists) {
        return processStack(exists ? 'update' : 'create', name, template)
      })
  }

  this.delete = function (overrideName) {
    startedAt = Date.now()
    return cf.deleteStack({ StackName: overrideName || name }).promise()
      .then(function () {
        return async ? Promise.resolve() : checkStack('delete', overrideName || name)
      })
  }

  this.validate = function () {
    return processTemplate(template)
      .then(function (templateObject) {
        return cf.validateTemplate(templateObject).promise()
      })
  }

  this.outputs = function () {
    return cf.describeStacks({ StackName: name }).promise()
      .then(function (data) {
        return flow(
          get('Stacks[0].Outputs'),
          keyBy('OutputKey'),
          mapValues('OutputValue')
        )(data)
      })
  }

  this.output = function (field) {
    return this.outputs()
      .then(function (data) {
        return data[field] || ''
      })
  }

  this.cleanup = function (opts) {
    const self = this
    let regex = opts.regex
    let minutesOld = opts.minutesOld
    let dryRun = opts.dryRun
    let async = opts.async
    let limit = opts.limit
    let next
    let done = false
    let stacks = []

    startedAt = Date.now()
    return (function loop () {
      if (!done) {
        return cf.listStacks({
          NextToken: next,
          StackStatusFilter: [
            'CREATE_COMPLETE',
            'CREATE_FAILED',
            'DELETE_FAILED',
            'ROLLBACK_COMPLETE',
            'UPDATE_COMPLETE'

          ]
        }).promise()
          .then(function (data) {
            next = data.NextToken
            done = !next
            return data.StackSummaries
          })
          .each(function (stack) {
            var millisOld = Date.now() - ((minutesOld || 0) * ONE_MINUTE)
            if (regex.test(stack.StackName) && moment(stack.CreationTime).valueOf() < millisOld) {
              stacks.push(stack)
            }
          })
          .then(function () {
            return loop()
          })
      }
      return Promise.resolve()
    })()
      .then(function () {
        var filteredStacks = _.sortBy(stacks, ['CreationTime'])

        if (limit) {
          filteredStacks = _.take(filteredStacks, limit)
        }
        _.forEach(filteredStacks, function (stack) {
          if (dryRun) {
            log('Will clean up ' + stack.StackName + ' Created ' + stack.CreationTime)
          } else {
            log('Cleaning up ' + stack.StackName + ' Created ' + stack.CreationTime)
            return self.delete(stack.StackName, async)
              .catch(function (err) {
                log('DELETE ERROR: ', err)
              })
          }
        })
      })
  }
}

var cfn = function (name, template) {
  return new Cfn(name, template).createOrUpdate()
}

cfn.stackExists = function (name) {
  return new Cfn(name).stackExists()
}

cfn.create = function (name, template) {
  return new Cfn(name, template).create()
}

cfn.delete = function (name) {
  return new Cfn(name).delete()
}

cfn.validate = function (region, template, params) {
  return new Cfn({
    template: template,
    params: params,
    awsConfig: {
      region: region
    }
  }).validate()
}

cfn.outputs = function (name) {
  return new Cfn(name).outputs()
}

cfn.output = function (name, field) {
  return new Cfn(name).output(field)
}

cfn.cleanup = function (regex, daysOld, dryRun) {
  return new Cfn().cleanup(regex, daysOld, dryRun)
}

cfn.configure = function (cfg) {
  _config = cfg
}

cfn.class = Cfn

module.exports = cfn
