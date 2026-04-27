import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DatabaseStack } from '../lib/database-stack';

test('Database Stack creates RDS instance, DynamoDB table, and RDS Proxy', () => {
  const app = new cdk.App();
  const stack = new DatabaseStack(app, 'TestDatabaseStack');
  const template = Template.fromStack(stack);

  // Verify the core resources exist
  template.resourceCountIs('AWS::RDS::DBInstance', 1);
  template.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
  template.resourceCountIs('AWS::RDS::DBProxy', 1);
  template.resourceCountIs('AWS::EC2::VPC', 1);
});
