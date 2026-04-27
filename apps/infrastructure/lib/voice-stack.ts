import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as connect from 'aws-cdk-lib/aws-connect';

export class VoiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Provision the Pooled (Shared) Amazon Connect Instance
    // This allows us to circumvent the strict AWS account limits on Connect instances
    const pooledConnectInstance = new connect.CfnInstance(this, 'MarketingSaaSConnectInstance', {
      attributes: {
        inboundCalls: false, // Core assumption: this is primarily an outbound bulk dialer
        outboundCalls: true,
        contactflowLogs: true,
        autoResolveBestVoices: true,
      },
      identityManagementType: 'CONNECT_MANAGED',
      instanceAlias: 'marketing-saas-pooled-dialer',
    });

    // 2. Mock Contact Flow JSON for Outbound Campaign with Answering Machine Detection (AMD)
    // Connect requires a heavily escaped stringified JSON format for Contact Flows
    const outboundAmdFlowContent = JSON.stringify({
      Version: "2019-10-30",
      StartAction: "1234abcd",
      Actions: [
        {
          Identifier: "1234abcd",
          Type: "MessageParticipant",
          Parameters: {
            Text: "Hello, this is a dynamic text to speech message for <workspace_id>.",
          },
          Transitions: {
            NextAction: "disconnect-action",
            Errors: [],
          },
        },
        {
          Identifier: "disconnect-action",
          Type: "DisconnectParticipant",
          Parameters: {},
          Transitions: {},
        }
      ]
    });

    // 3. Deploy the baseline Contact Flow
    const outboundFlow = new connect.CfnContactFlow(this, 'OutboundAmdContactFlow', {
      instanceArn: pooledConnectInstance.attrArn,
      name: 'Dynamic-Outbound-AMD-Flow',
      type: 'CONTACT_FLOW',
      content: outboundAmdFlowContent,
      description: 'Handles outbound campaign dialing, executes AMD, and plays poly voicemails.',
    });

    // Outputs
    new cdk.CfnOutput(this, 'AmazonConnectInstanceAlias', {
      value: pooledConnectInstance.instanceAlias || 'Pending',
    });
  }
}
