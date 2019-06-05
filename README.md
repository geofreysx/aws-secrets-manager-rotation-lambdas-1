# aws-secrets-manager-rotation-lambdas

aws secrets manager js lambdas for psql password rotation incl. cloudformation and other snippets


```

# cloudformation:
AWSSecretsManagerSecretRDSDBInstance:
  Type: AWS::SecretsManager::Secret
  Properties:
    Name: <Name> # whatever name suits your needs
    GenerateSecretString:
      SecretStringTemplate: '{ "username": "masteruser" }' # whatever name suits your needs
      GenerateStringKey: password
      PasswordLength: 128
      ExcludePunctuation: true # choose your pw composition. mind: set same settings in code manually

AWSSecretsManagerSecretTargetAttachment:
  Type: AWS::SecretsManager::SecretTargetAttachment
  Properties:
    SecretId:
      Ref: AWSSecretsManagerSecretRDSDBInstance
    TargetId:
      Ref: AWSRDSDBInstance
    TargetType: AWS::RDS::DBInstance

AWSSecretsManagerRotationSchedule:
  Type: AWS::SecretsManager::RotationSchedule
  Properties:
    RotationLambdaARN:
      Fn::GetAtt:
        - RotateLambdaFunction
        - Arn
    RotationRules:
      AutomaticallyAfterDays: 1 # set to automatically rotate each day
    SecretId:
      Ref: AWSSecretsManagerSecretRDSDBInstance

AWSLambdaPermissionSM:
  Type: AWS::Lambda::Permission
  DependsOn: RotateLambdaFunction
  Properties:
    FunctionName:
      Ref: RotateLambdaFunction
    Action: lambda:InvokeFunction
    Principal: secretsmanager.amazonaws.com

AWSRDSDBInstance:
  Type: AWS::RDS::DBInstance
  DeletionPolicy: Snapshot
  Properties:
    DBInstanceIdentifier: <DBInstanceIdentifier>
    DBName: <DBName>

    MasterUsername:
      Fn::Join:
        - ''
        - - '{{resolve:secretsmanager:'
          - Ref: AWSSecretsManagerSecretRDSDBInstance
          - ::username}}
    MasterUserPassword:
      Fn::Join:
        - ''
        - - '{{resolve:secretsmanager:'
          - Ref: AWSSecretsManagerSecretRDSDBInstance
          - ::password}}


# non cloudformation lambda example:
rotate:
  handler: src/database/rotate.handler # set your handler
  reservedConcurrency: 1 # just to be sure we have no race conditions
  memorySize: 2048 # set memory high to speed things up
  iamRoleStatements: # needed minimum permissions
    - Effect: Allow
      Action:
        - secretsmanager:DescribeSecret
        - secretsmanager:GetSecretValue
        - secretsmanager:PutSecretValue
        - secretsmanager:UpdateSecretVersionStage
      Resource: ${self:custom.resources.AWSSMSecretRDS.arn}
    - Effect: Allow
      Action:
        - secretsmanager:GetRandomPassword
      Resource: '*'


# your handler file should look similar to this
'use strict'
const { rotateSingleUser } = require('aws-secrets-manager-rotation-lambdas')
exports.handler = rotateSingleUser

```
