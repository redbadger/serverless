'use strict';

const BbPromise = require('bluebird');
const chalk = require('chalk');
const _ = require('lodash');
const moment = require('moment');
const validate = require('../lib/validate');

// helper functions
const getRoundedAvgDuration = (duration, functionsCount) =>
  (Math.round(duration * 100) / 100) / functionsCount;

const reduceDatapoints = (datapoints, statistic) => datapoints
  .reduce((previous, datapoint) => previous + datapoint[statistic], 0);

class AwsMetrics {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');

    Object.assign(this, validate);

    this.hooks = {
      'metrics:metrics': () => BbPromise.bind(this)
        .then(this.extendedValidate)
        .then(this.getMetrics)
        .then(this.showMetrics),
    };
  }

  extendedValidate() {
    this.validate();

    const today = new Date();
    let yesterday = new Date();
    yesterday = yesterday.setDate(yesterday.getDate() - 1);
    yesterday = new Date(yesterday);

    if (this.options.startTime) {
      const since = (['m', 'h', 'd']
        .indexOf(this.options.startTime[this.options.startTime.length - 1]) !== -1);
      if (since) {
        this.options.startTime = moment().subtract(this.options
          .startTime.replace(/\D/g, ''), this.options
          .startTime.replace(/\d/g, '')).valueOf();
      }
    } else {
      this.options.startTime = yesterday;
    }

    this.options.endTime = this.options.endTime || today;

    // finally create a new date object
    this.options.startTime = new Date(this.options.startTime);
    this.options.endTime = new Date(this.options.endTime);

    return BbPromise.resolve();
  }

  getMetrics() {
    // get all the function names in the service
    let functions = this.serverless.service.getAllFunctions()
      .map((func) => this.serverless.service.getFunction(func).name);

    if (this.options.function) {
      // validate if function can be found in service
      this.options.function = this.serverless.service.getFunction(this.options.function).name;

      // filter out the one function the user has specified through an option
      functions = functions.filter((func) => func === this.options.function);
    }

    return BbPromise.map(functions, (func) => {
      const FunctionName = func;
      const StartTime = this.options.startTime;
      const EndTime = this.options.endTime;
      const Namespace = 'AWS/Lambda';

      const hoursDiff = Math.abs(EndTime - StartTime) / 36e5;
      const Period = (hoursDiff > 24) ? 3600 * 24 : 3600;

      const promises = [];

      // get invocations
      const invocationsPromise =
        this.provider.request(
          'CloudWatch',
          'getMetricStatistics',
          {
            StartTime,
            EndTime,
            MetricName: 'Invocations',
            Namespace,
            Period,
            Dimensions: [
              {
                Name: 'FunctionName',
                Value: FunctionName,
              },
            ],
            Statistics: [
              'Sum',
            ],
            Unit: 'Count',
          },
          this.options.stage,
          this.options.region
        );
      // get throttles
      const throttlesPromise =
        this.provider.request(
          'CloudWatch',
          'getMetricStatistics',
          {
            StartTime,
            EndTime,
            MetricName: 'Throttles',
            Namespace,
            Period,
            Dimensions: [
              {
                Name: 'FunctionName',
                Value: FunctionName,
              },
            ],
            Statistics: [
              'Sum',
            ],
            Unit: 'Count',
          },
          this.options.stage,
          this.options.region
        );
      // get errors
      const errorsPromise =
        this.provider.request(
          'CloudWatch',
          'getMetricStatistics',
          {
            StartTime,
            EndTime,
            MetricName: 'Errors',
            Namespace,
            Period,
            Dimensions: [
              {
                Name: 'FunctionName',
                Value: FunctionName,
              },
            ],
            Statistics: [
              'Sum',
            ],
            Unit: 'Count',
          },
          this.options.stage,
          this.options.region
        );
      // get avg. duration
      const avgDurationPromise =
        this.provider.request(
          'CloudWatch',
          'getMetricStatistics',
          {
            StartTime,
            EndTime,
            MetricName: 'Duration',
            Namespace,
            Period,
            Dimensions: [
              {
                Name: 'FunctionName',
                Value: FunctionName,
              },
            ],
            Statistics: [
              'Average',
            ],
            Unit: 'Milliseconds',
          },
          this.options.stage,
          this.options.region
        );

      // push all promises to the array which will be used to resolve those
      promises.push(invocationsPromise);
      promises.push(throttlesPromise);
      promises.push(errorsPromise);
      promises.push(avgDurationPromise);

      return BbPromise.all(promises).then((metrics) => metrics);
    });
  }

  showMetrics(metrics) {
    let message = '';

    if (this.options.function) {
      message += `${chalk.yellow.underline(this.options.function)}\n`;
    } else {
      message += `${chalk.yellow.underline('Service wide metrics')}\n`;
    }

    const formattedStartTime = moment(this.options.startTime).format('LLL');
    const formattedEndTime = moment(this.options.endTime).format('LLL');
    message += `${formattedStartTime} - ${formattedEndTime}\n\n`;

    if (metrics && metrics.length > 0) {
      let invocations = 0;
      let throttles = 0;
      let errors = 0;
      let duration = 0;

      _.forEach(metrics, (metric) => {
        _.forEach(metric, (funcMetric) => {
          if (funcMetric.Label === 'Invocations') {
            invocations += reduceDatapoints(funcMetric.Datapoints, 'Sum');
          } else if (funcMetric.Label === 'Throttles') {
            throttles += reduceDatapoints(funcMetric.Datapoints, 'Sum');
          } else if (funcMetric.Label === 'Errors') {
            errors += reduceDatapoints(funcMetric.Datapoints, 'Sum');
          } else {
            duration += reduceDatapoints(funcMetric.Datapoints, 'Average');
          }
        });
      });
      const formattedDuration = `${getRoundedAvgDuration(duration, metrics.length)}ms`;
      // display the data
      message += `${chalk.yellow('Invocations:', invocations, '\n')}`;
      message += `${chalk.yellow('Throttles:', throttles, '\n')}`;
      message += `${chalk.yellow('Errors:', errors, '\n')}`;
      message += `${chalk.yellow('Duration (avg.):', formattedDuration)}`;
    } else {
      message += `${chalk.yellow('There are no metrics to show for these options')}`;
    }
    this.serverless.cli.consoleLog(message);
    return BbPromise.resolve(message);
  }
}

module.exports = AwsMetrics;
