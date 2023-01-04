import { ShardusTypes } from '@shardus/core'
import * as crypto from '@shardus/crypto-utils'
import { BN, isValidAddress } from 'ethereumjs-util'
import { networkAccount, ONE_SECOND } from '..'
import config from '../config'
import { ShardeumFlags } from '../shardeum/shardeumFlags'
import {
  AccountType,
  InternalTXType,
  NodeAccountQueryResponse,
  SetCertTime,
  WrappedEVMAccount,
  WrappedStates,
} from '../shardeum/shardeumTypes'
import * as AccountsStorage from '../storage/accountStorage'
import { fixDeserializedWrappedEVMAccount } from '../shardeum/wrappedEVMAccountFunctions'
import { Shardus } from '@shardus/core'
import { getNodeAccountWithRetry, InjectTxToConsensor } from '../handlers/queryCertificate'
import { getRandom } from '../utils'
import { toShardusAddress } from '../shardeum/evmAddress'
import * as WrappedEVMAccountFunctions from '../shardeum/wrappedEVMAccountFunctions'

export function isSetCertTimeTx(tx: any): boolean {
  if (tx.isInternalTx && tx.internalTXType === InternalTXType.SetCertTime) {
    return true
  }
  return false
}

export async function injectSetCertTimeTx(shardus: Shardus, publicKey: string, activeNodes: any) {
  // Query the nodeAccount and see if it is ready before injecting setCertTime
  const accountQueryResponse = await getNodeAccountWithRetry(publicKey, activeNodes)
  if (!accountQueryResponse.success) return accountQueryResponse

  const nodeAccountQueryResponse = accountQueryResponse as NodeAccountQueryResponse
  const nominator = nodeAccountQueryResponse.nodeAccount?.nominator

  // TODO: Validate the nodeAccount

  // Inject the setCertTime Tx
  const randomConsensusNode: any = getRandom(activeNodes, 1)[0]
  let tx = {
    isInternalTx: true,
    internalTXType: InternalTXType.SetCertTime,
    nominee: publicKey,
    nominator,
    duration: 10,
    // timestamp: Date.now(),
  }
  tx = shardus.signAsNode(tx)
  const result = await InjectTxToConsensor(randomConsensusNode, tx)
  console.log('INJECTED_SET_CERT_TIME_TX', result)
  return result
}

export function validateSetCertTimeTx(tx: SetCertTime, appData: any): { isValid: boolean; reason: string } {
  // nominee is NodeAccount2, will need here to verify address with other methods
  // if (!isValidAddress(tx.nominee)) {
  //   return { isValid: false, reason: 'Invalid nominee address' }
  // }
  if (!isValidAddress(tx.nominator)) {
    return { isValid: false, reason: 'Invalid nominator address' }
  }
  if (tx.duration <= 0) {
    return { isValid: false, reason: 'Duration in cert tx must be > 0' }
  }
  if (tx.timestamp <= 0) {
    return { isValid: false, reason: 'Duration in cert tx must be > 0' }
  }
  try {
    if (!crypto.verifyObj(tx)) return { isValid: false, reason: 'Invalid signature for SetCertTime tx' }
  } catch (e) {
    return { isValid: false, reason: 'Invalid signature for SetCertTime tx' }
  }

  return { isValid: true, reason: '' }
}

export function validateSetCertTimeState(tx: SetCertTime, wrappedStates: WrappedStates) {
  let committedStake = new BN(0)
  let stakeRequired = new BN(0)

  const operatorEVMAccount: WrappedEVMAccount =
    wrappedStates[toShardusAddress(tx.nominator, AccountType.Account)].data
  fixDeserializedWrappedEVMAccount(operatorEVMAccount)
  if (operatorEVMAccount == undefined) {
    /* prettier-ignore */ if (ShardeumFlags.VerboseLogs) console.log(`setCertTime apply: found no wrapped state for operator account ${tx.nominator}`)
  } else {
    if (operatorEVMAccount && operatorEVMAccount.operatorAccountInfo) {
      committedStake = operatorEVMAccount.operatorAccountInfo.stake
    }
  }

  const minStakeRequired = AccountsStorage.cachedNetworkAccount.current.stakeRequired

  // validate operator stake
  if (committedStake < minStakeRequired) {
    return {
      result: 'fail',
      reason: 'Operator has not staked the required amount',
    }
  }
  return { result: 'pass', reason: 'valid' }
}

export function applySetCertTimeTx(
  shardus,
  tx: SetCertTime,
  wrappedStates: WrappedStates,
  txTimestamp: number,
  applyResponse: ShardusTypes.ApplyResponse
) {
  const isValidRequest = validateSetCertTimeState(tx, wrappedStates)
  if (isValidRequest.result === 'fail') {
    /* prettier-ignore */ console.log(`Invalid SetCertTimeTx state, operator account ${tx.nominator}, reason: ${isValidRequest.reason}`)
  }
  const operatorAccountAddress = tx.nominator
  const operatorEVMAccount: WrappedEVMAccount =
    wrappedStates[toShardusAddress(tx.nominator, AccountType.Account)].data
  operatorEVMAccount.timestamp = txTimestamp
  fixDeserializedWrappedEVMAccount(operatorEVMAccount)

  console.log('operatorEVMAccount Before', operatorEVMAccount)

  // Update state
  const serverConfig: any = config.server
  operatorEVMAccount.operatorAccountInfo.certExp =
    txTimestamp + serverConfig.p2p.cycleDuration * ONE_SECOND * tx.duration
  operatorEVMAccount.account.balance = operatorEVMAccount.account.balance.sub(
    new BN(ShardeumFlags.constantTxFee)
  )

  console.log('operatorEVMAccount After', operatorEVMAccount)

  // Apply state
  const txId = crypto.hashObj(tx)
  if (ShardeumFlags.useAccountWrites) {
    const wrappedChangedAccount = WrappedEVMAccountFunctions._shardusWrappedAccount(operatorEVMAccount)
    shardus.applyResponseAddChangedAccount(
      applyResponse,
      operatorAccountAddress,
      wrappedChangedAccount,
      txId,
      txTimestamp
    )
  }
}