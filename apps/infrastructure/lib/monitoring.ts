import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';

export interface DispatchAlarmsProps {
  /** Logical prefix for alarm construct IDs, e.g. 'Email'. */
  prefix: string;
  dlq: sqs.Queue;
  fn: lambda.IFunction;
  alarmTopic: sns.ITopic;
}

/**
 * Standard dispatch observability: page someone when messages land in the
 * DLQ (campaign sends gave up after retries) or the Lambda itself errors.
 */
export function addDispatchAlarms(scope: Construct, props: DispatchAlarmsProps): void {
  const { prefix, dlq, fn, alarmTopic } = props;
  const action = new cloudwatchActions.SnsAction(alarmTopic);

  const dlqAlarm = new cloudwatch.Alarm(scope, `${prefix}DlqDepthAlarm`, {
    alarmDescription: `${prefix} dispatch DLQ has messages — campaign sends failed after all retries. See docs/runbooks/dispatch-dlq.md`,
    metric: dlq.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  dlqAlarm.addAlarmAction(action);

  const errorAlarm = new cloudwatch.Alarm(scope, `${prefix}DispatchErrorsAlarm`, {
    alarmDescription: `${prefix} dispatch Lambda reported invocation errors.`,
    metric: fn.metricErrors({
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  errorAlarm.addAlarmAction(action);
}
