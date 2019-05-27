'use strict'

const aws = require('aws-sdk')
const secretsManager = new aws.SecretsManager()

const knex = require('knex')

const log = obj => console.log(JSON.stringify(obj, null, 2))

async function handler(event) {
  log({ log: { event } })

  const { SecretId, ClientRequestToken, Step } = event

  const metadata = await secretsManager.describeSecret(
    { SecretId: SecretId }
  ).promise()
  if (!metadata.RotationEnabled)
    throw new Error(`error::secret ${SecretId} rotation disabled`)

  const versions = metadata.VersionIdsToStages
  if (!versions[ClientRequestToken])
    throw new Error(`error::secret ${SecretId} no secret version ${ClientRequestToken}`)

  if (versions[ClientRequestToken].includes('AWSCURRENT')) {
    log({ log: `info::secret ${SecretId} current is version ${ClientRequestToken}` })
  } else if (versions[ClientRequestToken].includes('AWSPENDING')) {
    if (Step === 'createSecret')
      await createSecret(SecretId, ClientRequestToken)
    else if (Step === 'setSecret')
      await setSecret(SecretId, ClientRequestToken)
    else if (Step === 'testSecret')
      await testSecret(SecretId, ClientRequestToken)
    else if (Step === 'finishSecret')
      await finishSecret(SecretId, ClientRequestToken)
    else {
      throw new Error(`error::secret ${SecretId} Step ${Step} invalid`)
    }
  } else {
    throw new Error(`error::secret ${SecretId} pending not version ${ClientRequestToken}`)
  }
}

async function createSecret(SecretId, ClientRequestToken) {
  log({ log: 'createSecret' })

  const currentSecret = await getSecret(SecretId, 'AWSCURRENT')

  try { await getSecret(SecretId, 'AWSPENDING', ClientRequestToken) }
  catch (error) {
    // const password = (await secretsManager.getRandomPassword(
    //   { PasswordLength: 128, ExcludeCharacters: '/"@' }
    // ).promise()).RandomPassword
    const password = 'foobar'

    await secretsManager.putSecretValue(
      {
        SecretId: SecretId,
        ClientRequestToken: ClientRequestToken,
        SecretString: JSON.stringify(
          {
            ...currentSecret,
            ...{ password }
          }
        ),
        VersionStages: ['AWSPENDING']
      }
    ).promise()
  }

  log({ log: `info::secret ${SecretId} version ${ClientRequestToken}` })
}

async function setSecret(SecretId, ClientRequestToken) {
  log({ log: 'setSecret' })

  let dbConnection = null
  try {
    const pendingSecret = await getSecret(SecretId, 'AWSPENDING', ClientRequestToken)
    log({ log: 'using::pendingSecret' })
    dbConnection = await getDbConnection(pendingSecret)

    if (!dbConnection) {
      const currentSecret = await getSecret(SecretId, 'AWSCURRENT')
      log({ log: 'using::currentSecret' })
      dbConnection = await getDbConnection(currentSecret)

      if (!dbConnection) {
        const previousDict = await getSecret(SecretId, 'AWSPREVIOUS')
        log({ log: 'using::previousDict' })
        dbConnection = await getDbConnection(previousDict)

        if (!dbConnection) {
          throw new Error(`error::setSecret::secret ${SecretId} is invalid`)
        }
      }

      log({ log: 'setting::password' })

      await dbConnection.raw(
        `alter user ?? with password ?`,
        [pendingSecret.username, pendingSecret.password]
      )

      log({ log: `info::secret ${SecretId} rotated` })
    }
    else {
      log({ log: `info::secret ${SecretId} pending is version ${ClientRequestToken}` })
    }
  } finally { await dbConnection.destroy() }
}

async function testSecret(SecretId, ClientRequestToken) {
  log({ log: 'testSecret' })

  const pendingSecret = await getSecret(SecretId, 'AWSPENDING', ClientRequestToken)
  const dbConnection = await getDbConnection(pendingSecret)

  if (dbConnection) {
    try { dbConnection.raw(`select now()`) }
    finally { dbConnection.destroy() }

    log({ log: `info::pendingSecret ${SecretId} test success` })
  } else {
    throw new Error(`error::testSecret::pendingSecret ${SecretId} test fail`)
  }
}

async function finishSecret(SecretId, ClientRequestToken) {
  log({ log: 'finishSecret' })

  const metadata = await secretsManager.describeSecret(
    { SecretId: SecretId }
  ).promise()
  let currentVersion = null

  console.log(metadata.VersionIdsToStages)

  for (const [key, value] of Object.entries(metadata.VersionIdsToStages)) {
    if (value.includes('AWSCURRENT')) {
      if (key === ClientRequestToken) {
        log({ log: `info::secret ${SecretId} current is version ${ClientRequestToken}` })
        return
      }

      currentVersion = key
      break
    }
  }

  secretsManager.updateSecretVersionStage(
    {
      SecretId: SecretId,
      VersionStage: 'AWSCURRENT',
      MoveToVersionId: ClientRequestToken,
      RemoveFromVersionId: currentVersion
    }
  ).promise()

  log(
    { log: `info::secret ${SecretId} current set version ${currentVersion}` }
  )
}

async function getDbConnection(secretDict) {
  log({ log: 'getDbConnection' })

  try {
    const dbConnection = await knex(
      {
        client: 'pg',
        connection: {
          host: secretDict.host,
          user: secretDict.username,
          password: secretDict.password,
          database: secretDict.dbname
        },
        pool: { min: 0, max: 1 }
      }
    )

    log({ log: 'dbConnection established' })

    return dbConnection
  } catch (error) {
    log(error)

    return null
  }
}

async function getSecret(SecretId, stage, ClientRequestToken) {
  log({ log: 'getSecret' })

  const secret = JSON.parse(
    (await secretsManager.getSecretValue(
      {
        SecretId: SecretId,
        ...(ClientRequestToken ? { VersionId: ClientRequestToken } : {}),
        VersionStage: stage
      }
    ).promise()).SecretString
  )

  if (secret.engine !== 'postgres')
    throw new Error(`error::secret ${SecretId} invalid db engine`)

  for (const key of ['host', 'username', 'password']) {
    if (!secret[key])
      throw new Error(`error::secret ${SecretId} missing key ${key}`)
  }

  return secret
}

exports.handler = handler