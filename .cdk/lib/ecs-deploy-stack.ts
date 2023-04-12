import { Stack, StackProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import {
  IVpc,
  IRoute53,
  IAcm,
  ISecretsManager,
  IContainer,
  ICloudWatchAlarm,
  IAutoscaling,
  ILoadBalancer,
  ITask,
  IPolicy,
  ICustomTags,
} from "../config";

export interface EcsDeployStackProps extends StackProps {
  stage: string;
  stackName: string;
  appName: string;
  vpc: IVpc;
  route53: IRoute53;
  secretsManager?: ISecretsManager[];
  container: IContainer;
  task: ITask;
  autoscaling?: IAutoscaling;
  loadBalancer?: ILoadBalancer;
  acm?: IAcm;
  cloudWatchAlarm?: {
    cpu: ICloudWatchAlarm;
    memory: ICloudWatchAlarm;
    taskCount: ICloudWatchAlarm;
    errorFromLog: ICloudWatchAlarm;
  };
  extraPolicies?: IPolicy[];
  customTags?: ICustomTags;
}

export class EcsDeployStack extends Stack {
  constructor(scope: Construct, id: string, props: EcsDeployStackProps) {
    super(scope, id, props);

    // Verifying if values are being declared
    if (!props.vpc.id && !props.vpc.name) {
      throw new Error("Either Vpc Id or Vpc Name should be set.");
    }

    const protocol = props.acm && !props.acm.create && !props.acm.arn ? "HTTP" : "HTTPS";

    // Full domain name for the application Eg: <www>.<api.com>
    const fullDomainName = `${props.route53.hostname}.${props.route53.domain}`;

    // Build Docker image
    const srcImage = new ecrAssets.DockerImageAsset(this, "DockerImage", {
      directory: path.join(__dirname, "../../"),
      buildArgs: props.container.buildArgs
    });

    // Retrieving VPC information
    const vpc = ec2.Vpc.fromLookup(this, "Vpc", {
      vpcId: props.vpc.id,
      vpcName: props.vpc.name,
    });

    // Retrieving the hosted zone
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: props.route53.domain!,
    })

    // Retrieving ACM certificate or Create
    const certificate = this.getAcmCertificate(
      protocol,
      hostedZone,
      fullDomainName,
      props.acm?.arn
    );

    // Creating ECS Services resources
    const loadBalancedFargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      "Service",
      {
        vpc,
        protocol: elbv2.ApplicationProtocol[protocol],
        desiredCount: props.task.desiredCount || 1,
        cpu: props.task.cpu || 256,
        memoryLimitMiB: props.task.memoryLimitMiB || 512,
        publicLoadBalancer: true,
        enableECSManagedTags: true,
        certificate: certificate || undefined,
        domainZone: hostedZone || undefined,
        domainName: hostedZone && fullDomainName,
        circuitBreaker: {
          rollback: true,
        },
        taskSubnets: {
          subnets: [...vpc.privateSubnets],
        },
        taskImageOptions: {
          containerPort: props.container.port || 80,
          image: ecs.ContainerImage.fromRegistry(srcImage.imageUri),
          secrets: props.secretsManager && this.generateSecretList(props.secretsManager!),
        },
        enableExecuteCommand: true,
      }
    );

    // Healthcheck
    loadBalancedFargateService.targetGroup.configureHealthCheck({
      path: props.loadBalancer?.healthcheckPath || "/",
    });
    loadBalancedFargateService.targetGroup.setAttribute(
      "deregistration_delay.timeout_seconds",
      "60"
    );

    // Fargate Spot
    if (props.task.spot) {
      const cfnService = loadBalancedFargateService.service.node.tryFindChild(
        "Service"
      ) as ecs.CfnService;
      cfnService.launchType = undefined;
      cfnService.capacityProviderStrategy = [
        {
          capacityProvider: "FARGATE_SPOT",
          weight: 4,
        },
        {
          capacityProvider: "FARGATE",
          weight: 1,
        },
      ];
    }

    // Auto Scalling
    const scalableTarget = loadBalancedFargateService.service.autoScaleTaskCount({
      minCapacity: props.autoscaling?.minCapacity || 1,
      maxCapacity: props.autoscaling?.maxCapacity || 8,
    });

    scalableTarget.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: props.autoscaling?.cpuTargetUtilizationPercent || 80,
    });

    if (props.extraPolicies) {
      props.extraPolicies.forEach((extraPolicy: IPolicy) => {
        loadBalancedFargateService.taskDefinition.addToTaskRolePolicy(
          new iam.PolicyStatement({
            resources: extraPolicy["resources"],
            actions: extraPolicy["actions"],
            effect: iam.Effect.ALLOW,
          })
        );
      });
    }

    // Include permissions to ECR
    loadBalancedFargateService.taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        resources: ["*"],
        actions: ["ecr:*"],
        effect: iam.Effect.ALLOW,
      })
    );

    // Alarms

    // ALARM CPU UTILIZATION
    loadBalancedFargateService.service
      .metricCpuUtilization()
      .createAlarm(this, "AlarmCpuUtilization", {
        alarmName: `Alarm${props.stackName}CpuUtilization`,
        threshold: props.cloudWatchAlarm?.cpu.alarmThreshold || 60,
        //threshold: props.cloudWatchAlarm.alarmThreshold['cpu-utilization']?.threshold || 60,
        evaluationPeriods: props.cloudWatchAlarm?.cpu.evaluationPeriods || 1,
        datapointsToAlarm: props.cloudWatchAlarm?.cpu.datapointsToAlarm,
        alarmDescription: `Alarming CPU Utilization higher than ${
          props.cloudWatchAlarm?.cpu.alarmThreshold || 60
        } for service ${props.appName}`,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      });

    // ALARM MEMORY UTILIZATION
    loadBalancedFargateService.service
      .metricMemoryUtilization()
      .createAlarm(this, "AlarmMemoryUtilization", {
        alarmName: `Alarm${props.stackName}MemoryUtilization`,
        threshold: props.cloudWatchAlarm?.memory.alarmThreshold || 75,
        evaluationPeriods: props.cloudWatchAlarm?.memory.evaluationPeriods || 1,
        datapointsToAlarm: props.cloudWatchAlarm?.memory.datapointsToAlarm,
        alarmDescription: `Alarming Memory Utilization higher than ${
          props.cloudWatchAlarm?.memory.alarmThreshold || 75
        } for service ${props.appName}`,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      });

    // ALARM ECS RUNNING TASK
    loadBalancedFargateService.service
      .metric("RunningTaskCount")
      .createAlarm(this, "AlarmRunningTaskCount", {
        alarmName: `AlarmAlarm${props.stackName}RunningTaskCount`,
        threshold: props.autoscaling?.minCapacity || 1,
        evaluationPeriods: 1,
        alarmDescription: `Alarming Tasks running bellow than ${
          props.autoscaling?.minCapacity || 1
        } for service ${props.appName}`,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      });

    // CLOUDWATCH DASHBOARD
    const dashboard = new cloudwatch.Dashboard(this, "Dashboard");
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown:
          "# Load Balancer\nmetrics to monitor load balancer metrics:\n* Amount of incoming requests\n* Latency with an alarm if max accepted latency exceeded.",
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Requests",
        width: 9,
        left: [loadBalancedFargateService.loadBalancer.metricRequestCount()],
      }),
      new cloudwatch.GraphWidget({
        title: "Latency",
        width: 9,
        left: [loadBalancedFargateService.loadBalancer.metricTargetResponseTime()],
      })
    );
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown:
          "# ECS Service\nmetrics to monitor service metrics:\n* CPU Utilization\n*Memory Utilization",
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Cpu Utilization",
        width: 9,
        left: [loadBalancedFargateService.service.metricCpuUtilization()],
      }),
      new cloudwatch.GraphWidget({
        title: "Memory Utilization",
        width: 9,
        left: [loadBalancedFargateService.service.metricMemoryUtilization()],
      })
    );

    // Tagging all resources in the stack
    Tags.of(this).add("Application", props.appName);
    Tags.of(this).add("Environment", props.stage);
    props.customTags && Tags.of(this).add(props.customTags?.key, props.customTags?.value);
  }

  // Generate Secret list that will be inject in the container
  private generateSecretList = (secrets: ISecretsManager[]) => {
    const obj: any = {};

    secrets.forEach((secret, index) => {
      const secretsManager = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        `Secret${index}`,
        secret.arn
      );
      Object.keys(secret.variables).forEach((key) => {
        return (obj[secret.variables[key]] = ecs.Secret.fromSecretsManager(secretsManager, key));
      });
    });

    return obj;
  };

  private getAcmCertificate = (
    protocol: "HTTP" | "HTTPS",
    hostedZone?: route53.IHostedZone,
    domainName?: string,
    certificateArn?: string
  ) => {
    if (protocol === "HTTP") return undefined;

    if (certificateArn) {
      return acm.Certificate.fromCertificateArn(this, "Certificate", certificateArn!);
    }

    if (!hostedZone && certificateArn) {
      throw new Error("Route53 is needed to create an ACM certificate.");
    }

    return new acm.DnsValidatedCertificate(this, "Certificate", {
      hostedZone: hostedZone!,
      domainName: domainName!,
    });
  };
}
