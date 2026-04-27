import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ses from 'aws-cdk-lib/aws-ses';

export class EmailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Provide a placeholder Identity that would be dynamically provisioned per workspace
    // in a real scenario, or defined for the core application here.
    const defaultIdentity = ses.Identity.domain('mail.yourdomain.com');

    new ses.EmailIdentity(this, 'MarketingSaaSEmailIdentity', {
      identity: defaultIdentity,
      mailFromDomain: 'bounce.yourdomain.com',
    });

    // Dedicated IP Pool for warming up IPs automatically via SES Managed IPs
    // In actual production, you have to contact AWS Support to enable SES Managed IPs
    // before deploying this exact construct, but this represents the architecture.
    new ses.DedicatedIpPool(this, 'MarketingSaaSIpPool', {
      dedicatedIpPoolName: 'marketing-saas-production-pool',
      scalingMode: ses.ScalingMode.MANAGED, // Automatically handles warmup!
    });
  }
}
