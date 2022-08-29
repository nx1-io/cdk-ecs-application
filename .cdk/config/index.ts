const configGLobal = require("../cdk.config.json");

interface IAws {
  readonly account_name: string;
  readonly account: string;
  readonly region: string;
}

export interface IVpc {
  readonly name?: string;
  readonly id?: string;
}

export interface IRoute53 {
  readonly enable: boolean;
  readonly domain: string;
  readonly hostname: string;
}

export interface IAcm {
  readonly create: boolean;
  readonly arn: string;
}

export interface ISecretsManager {
  readonly arn: string;
  readonly variables: {
    [key: string]: string;
  };
}

export interface IContainer {
  readonly port: number;
  readonly image: {
    readonly uri: string;
    readonly version?: string;
  };
  readonly buildArgs: {
    [key: string]: string;
  };
}

export interface ITask {
  readonly desiredCount: number;
  readonly cpu: number;
  readonly memoryLimitMiB: number;
  readonly spot: boolean;
}

export interface IAutoscaling {
  readonly minCapacity: number;
  readonly maxCapacity: number;
  readonly cpuTargetUtilizationPercent: number;
}

export interface ILoadBalancer {
  readonly healthcheckPath: string;
}

export interface ICloudWatchAlarm {
  readonly alarmThreshold: number;
  readonly evaluationPeriods: number;
  readonly datapointsToAlarm?: number;
}

export interface IEcs {
  readonly cluster_arn: string;
  readonly clusterSecurityGroupId: string;
}

export interface IStages {
  [key: string]: {
    aws: IAws;
    vpc?: IVpc;
    route53: IRoute53;
    acm: IAcm;
    secretsManager: ISecretsManager[];
    task: ITask;
    autoscaling?: IAutoscaling;
    loadBalancer?: ILoadBalancer;
    ecs: IEcs;
  };
}

export interface IEnvironmentConfig {
  readonly name: string;
  readonly container: IContainer;
  readonly stages: IStages;
}

const Environment: IEnvironmentConfig = configGLobal;

export default Environment;
