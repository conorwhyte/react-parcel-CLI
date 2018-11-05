# Build Parcel App 

Create React apps using Parcel, with zero configuration. 

Features that comes preconfigured: 

- Most of the features that come out of the box with create-react-app, minus the serviceWorker (with the option coming soon!). 
- Uses Parcel instead of Webpack, to remove all those webpack dependancies and provide true zero config. 
- The addition of React Router, Flux and Sass. 
- Setup an S3 bucket and CloudFront distribution on initial creation, to instantly deploy the site. 
- Testing using both Jest/Enzyme (unit tests) and Puppeteer (intergration/E2E tests). 
- Removal of the start scripts relying on react-scripts. I like to have full visibility of what each command is doing in the project. 

## Installation 

```
npm i -g build-parcel-app 
```

## Build an app 

``` 
bpa MyReactApp
```

Build with setup of S3 and CloudFront distribution. 

```
bpa MyReactApp --createSite test.myreactapp.com
```

Notes on AWS setup: 
- Ensure your enviroment has been setup i.e `aws configure`. Make sure the IAM user being used has teh necessary permissions to create S3 buckets and CloudFront distributions. 
- S3 buckets are unique, you cannot choose a name used by another used. 

## Initial setup 

``` 
yarn start 
```

To run the tests: 
```
yarn test       // Runs the jest unit tests

yarn puppet     // Runs the puppeteer E2E tests. 
```

To run a production build: 
```
yarn build
```

To deploy to the S3 bucket, where bucket is the same name as specified on initial creation: 
```
BUCKET=test.myreactapp.com yarn deploy
``` 

## Acknowledgements 
- [create-react-app](https://github.com/facebook/create-react-app) - The main inspiration for this project. 
- [create-react-app-parcel](https://github.com/sw-yx/create-react-app-parcel) - A lot of this code is based on this project, this is more of an extension to this project. The slides and video created by sw-jx was of a huge help also to understand how C.R.A and C.R.A.P works. 
- [parcel](https://github.com/parcel-bundler/parcel) - An awesome zero config bundler. 

## Contributions 
All contributions and suggestions are welcome!! :) 

## 