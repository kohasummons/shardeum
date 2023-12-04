import { getShardusAPI } from '../../../index'

export const alias = dapp => async (req, res): Promise<void> => {
  try {
    const id = req.params['id']
    const account = await getShardusAPI().getLocalOrRemoteAccount(id)
    res.json({ handle: account && account.data.alias })
  } catch (error) {
    dapp.log(error)
    res.json({ error })
  }
}
