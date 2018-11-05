#!/usr/bin/env node
'use strict'

const cfn = require('./')
const _ = require('lodash')
const chalk = require('chalk')
const meow = require('meow')
const Promise = require('bluebird')
// const path = require('path')
// const cwd = process.cwd()

Promise.longStackTraces()

const cli = meow(`
  Usage
    cfn deploy {stack name} {template} [--{param key}={param value}...]
    cfn delete {stack name}
    cfn outputs {stack name}
    cfn output {stack name} {field name}

  Examples
    cfn deploy my-stack template.js
    cfn deploy your_stack template.yml --ImageId=ami-828283 --VpcId=vpc-828283
    cfn delete your_stack
    cfn outputs my-stack
    cfn output my-stack my-field
`)

const cmds = {
  deploy: {
    args: 3,
    exec: () => {
      const name = cli.input[1]
      // const template = path.join(cwd, cli.input[2])
      const template = cli.input[2]

      let cfParams = cli.flags
      if (cfParams && cfParams.length > 0) {
        console.log(`${chalk.cyan('Cloud Formation Parameters')}\n==========================`)
        console.log(_.toPairs(cfParams).map(a => `${a[0]}: ${a[1]}`).join('\n'))
        console.log('==========================`)\n')
      }

      return cfn({name, template, cfParams})
    }
  },

  delete: {
    args: 2,
    exec: () => {
      const name = cli.input[1]
      return cfn.delete(name)
    }
  },

  outputs: {
    args: 2,
    exec: () => {
      const name = cli.input[1]
      return cfn.outputs(name)
        .then(JSON.stringify)
        .then(console.log)
    }
  },

  output: {
    args: 3,
    exec: () => {
      const name = cli.input[1]
      const field = cli.input[2]
      return cfn.output(name, field)
        .then(console.log)
    }
  }
}

const exec = () => {
  const len = cli.input.length
  if (len < 1) {
    return Promise.reject(new Error(chalk.red('Invalid Usage')))
  }
  const cmdName = cli.input[0]
  const cmd = cmds[cmdName]
  if (!cmd || (len < cmd.args)) {
    return Promise.reject(new Error(chalk.red('Invalid Usage')))
  }

  return cmd.exec()
}

exec().catch(err => {
  console.error(chalk.red(err.message || err))
  cli.showHelp(1)
})
