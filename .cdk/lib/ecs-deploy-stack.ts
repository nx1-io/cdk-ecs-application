import { Stack, StackProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53_targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecrdeploy from "cdk-ecr-deployment";
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
} from "../config";

export interface EcsDeployStackProps extends StackProps {
  stage: string;
  stackName: string;
  appName: string;
  clusterArn: string;
  clusterSecurityGroupId: string;
  vpc: IVpc;
  route53: IRoute53;
  secretsManager?: ISecretsManager[];
  container: IContainer;
  task: ITask;
  autoscaling?: IAutoscaling;
  loadBalancer?: ILoadBalancer;
  acm: IAcm;
  cloudWatchAlarm?: {
    cpu: ICloudWatchAlarm;
    memory: ICloudWatchAlarm;
    taskCount: ICloudWatchAlarm;
    errorFromLog: ICloudWatchAlarm;
  };
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

    // Docker image name
    const destImage = `${props.container.image.uri}:${props.container.image.version || "latest"}`;

    // Build Docker image
    const srcImage = new ecrAssets.DockerImageAsset(this, "DockerImage", {
      directory: path.join(__dirname, "../../"),
      buildArgs: props.container.buildArgs
    });

    // Push Docker image to ECR Repository
    new ecrdeploy.ECRDeployment(this, "DeployDockerImage", {
      src: new ecrdeploy.DockerImageName(srcImage.imageUri),
      dest: new ecrdeploy.DockerImageName(destImage),
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
    const listenerCertificate = elbv2.ListenerCertificate.fromArn(props.acm.arn);



    // Application load balancer
    const alb = new elbv2.ApplicationLoadBalancer(
      this,
      `alb`,
      {
        vpc,
        vpcSubnets: { subnets: vpc.publicSubnets },
        internetFacing: true
      }
    );


    // Target group to make resources containers dicoverable by the application load balencer
    const targetGroupHttp = new elbv2.ApplicationTargetGroup(
      this,
      "target-group",
      {
        port: props.container.port || 80,
        vpc,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
      }
    );

    // Health check for containers to check they were deployed correctly
    targetGroupHttp.configureHealthCheck({
      path: props.loadBalancer?.healthcheckPath || "/",
      protocol: elbv2.Protocol.HTTP,
    });


    // only allow HTTPS connections
    const listener = alb.addListener("alb-listener", {
      open: true,
      port: 443,
      certificates: [ listenerCertificate ],
    });

    listener.addTargetGroups("alb-listener-target-group", {
      targetGroups: [targetGroupHttp],
    });

    // use a security group to provide a secure connection between the ALB and the containers
    const albSG = new ec2.SecurityGroup(this, "alb-SG", {
      vpc,
      allowAllOutbound: true,
    });

    albSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow https traffic"
    );

    alb.addSecurityGroup(albSG);

    // Retriving Security Groups
    const clusterSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, "ClusterSecurityGroup", props.clusterSecurityGroupId)

    // Retrieving the ecs cluster

    const cluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
      vpc: vpc,
      securityGroups:[clusterSecurityGroup],
      clusterName: 'dev-apps',
      clusterArn: props.clusterArn
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: props.task.cpu || 256,
      memoryLimitMiB: props.task.memoryLimitMiB || 512

    });

    const container = taskDefinition.addContainer('Container', {
      image: ecs.ContainerImage.fromRegistry(destImage),
      secrets: props.secretsManager && this.generateSecretList(props.secretsManager!),
      logging: ecs.LogDriver.awsLogs({ streamPrefix: "webserver-service-logs" }),
    });
    container.addPortMappings({containerPort: props.container.port || 80})


    // Instantiate an Amazon ECS Service
    const ecsService = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      circuitBreaker: {
        rollback: true,
      },
      vpcSubnets: {
        subnets: [...vpc.privateSubnets],
      },
      assignPublicIp: false,
      desiredCount: props.task.desiredCount || 1,
      securityGroups: [clusterSecurityGroup]
    });

    // add to a target group so make containers discoverable by the application load balancer
    ecsService.attachToApplicationTargetGroup(targetGroupHttp);


    // Autoscaling based on memory and CPU usage
    const scalableTaget = ecsService.autoScaleTaskCount({
      minCapacity: props.autoscaling?.minCapacity || 1,
      maxCapacity: props.autoscaling?.maxCapacity || 4,
    });

    scalableTaget.scaleOnCpuUtilization("ScaleUpCPU", {
      targetUtilizationPercent: props.autoscaling?.cpuTargetUtilizationPercent || 80
    });

    // Include permissions to ECR
    ecsService.taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        resources: ["*"],
        actions: ["ecr:*"],
        effect: iam.Effect.ALLOW,
      })
    );

    // Route traffic hitting   to the Application Load Balancer
    new route53.ARecord(this, 'WebServerDomainToLoadBalancer', {
      recordName: 'webserver',
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new route53_targets.LoadBalancerTarget(alb)),
    });


    // Alarms

    // ALARM CPU UTILIZATION
    ecsService.metricCpuUtilization()
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
    ecsService.metricMemoryUtilization()
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
    ecsService.metric("RunningTaskCount")
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
        left: [alb.metricRequestCount()],
      }),
      new cloudwatch.GraphWidget({
        title: "Latency",
        width: 9,
        left: [alb.metricTargetResponseTime()],
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
        left: [ecsService.metricCpuUtilization()],
      }),
      new cloudwatch.GraphWidget({
        title: "Memory Utilization",
        width: 9,
        left: [ecsService.metricMemoryUtilization()],
      })
    );

    // Tagging all resources in the stack
    Tags.of(this).add("Application", props.appName);
    Tags.of(this).add("Environment", props.stage);
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
