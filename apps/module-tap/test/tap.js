/* eslint-disable no-undef */
const { assertRevert } = require('@aragon/test-helpers/assertThrow')
const blockNumber = require('@aragon/test-helpers/blockNumber')(web3)
const getBalance = require('@aragon/test-helpers/balance')(web3)
const assertEvent = require('@aragon/test-helpers/assertEvent')
const timeTravel = require('@aragon/test-helpers/timeTravel')(web3)
const { hash } = require('eth-ens-namehash')

const getEvent = (receipt, event, arg) => {
  return receipt.logs.filter(l => l.event === event)[0].args[arg]
}
const getTimestamp = receipt => {
  return web3.eth.getBlock(receipt.receipt.blockNumber).timestamp
}

const getBlocknumber = receipt => {
  return web3.eth.getBlock(receipt.receipt.blockNumber).number
}

const Kernel = artifacts.require('Kernel')
const ACL = artifacts.require('ACL')
const EVMScriptRegistryFactory = artifacts.require('EVMScriptRegistryFactory')
const DAOFactory = artifacts.require('DAOFactory')
const Vault = artifacts.require('Vault')
const Tap = artifacts.require('Tap')
const Controller = artifacts.require('SimpleMarketMakerController')
const EtherTokenConstantMock = artifacts.require('EtherTokenConstantMock')
const TokenMock = artifacts.require('TokenMock')
const ForceSendETH = artifacts.require('ForceSendETH')

contract('Tap app', accounts => {
  let factory, dao, acl, vBase, tBase, controller, reserve, beneficiary, tap, token1, token2
  let ETH,
    APP_MANAGER_ROLE,
    TRANSFER_ROLE,
    UPDATE_RESERVE_ROLE,
    UPDATE_BENEFICIARY_ROLE,
    UPDATE_MAXIMUM_TAP_INCREASE_RATE_ROLE,
    ADD_TAPPED_TOKEN_ROLE,
    REMOVE_TAPPED_TOKEN_ROLE,
    UPDATE_TAPPED_TOKEN_ROLE,
    WITHDRAW_ROLE

  const VAULT_ID = hash('vault.aragonpm.eth')
  const TAP_ID = hash('tap.aragonpm.eth')

  const BATCH_BLOCKS = 10
  const INITIAL_ETH_BALANCE = 100000000
  const INITIAL_TOKEN_BALANCE = 100000000
  const MAX_TAP_INCREASE_PCT = 50 * Math.pow(10, 16)

  const root = accounts[0]
  const authorized = accounts[1]
  const unauthorized = accounts[2]

  const forceSendETH = async (to, value) => {
    // Using this contract ETH will be send by selfdestruct which always succeeds
    const forceSend = await ForceSendETH.new()
    return forceSend.sendByDying(to, { value })
  }

  const getBatchId = receipt => {
    const blocknumber = web3.eth.getBlock(receipt.receipt.blockNumber).number

    return Math.floor(blocknumber / BATCH_BLOCKS) * BATCH_BLOCKS
  }

  const progressToNextBatch = async () => {
    let currentBlock = await blockNumber()
    let currentBatch = await tap.getCurrentBatchId()
    let blocksTillNextBatch = currentBatch.plus(BATCH_BLOCKS).sub(currentBlock)
    await increaseBlocks(blocksTillNextBatch)
  }

  const increaseBlocks = blocks => {
    if (typeof blocks === 'object') {
      blocks = blocks.toNumber(10)
    }
    return new Promise((resolve, reject) => {
      increaseBlock().then(() => {
        blocks -= 1
        if (blocks === 0) {
          resolve()
        } else {
          increaseBlocks(blocks).then(resolve)
        }
      })
    })
  }

  const increaseBlock = () => {
    return new Promise((resolve, reject) => {
      web3.currentProvider.sendAsync(
        {
          jsonrpc: '2.0',
          method: 'evm_mine',
          id: 12345,
        },
        (err, result) => {
          if (err) reject(err)
          resolve(result)
        }
      )
    })
  }

  const initialize = async _ => {
    // DAO
    const dReceipt = await factory.newDAO(root)
    dao = await Kernel.at(getEvent(dReceipt, 'DeployDAO', 'dao'))
    acl = ACL.at(await dao.acl())
    await acl.createPermission(root, dao.address, APP_MANAGER_ROLE, root, { from: root })
    // reserve
    const rReceipt = await dao.newAppInstance(VAULT_ID, vBase.address, '0x', false)
    reserve = await Vault.at(getEvent(rReceipt, 'NewAppProxy', 'proxy'))
    // beneficiary
    const bReceipt = await dao.newAppInstance(VAULT_ID, vBase.address, '0x', false)
    beneficiary = await Vault.at(getEvent(bReceipt, 'NewAppProxy', 'proxy'))
    // tap
    const tReceipt = await dao.newAppInstance(TAP_ID, tBase.address, '0x', false)
    tap = await Tap.at(getEvent(tReceipt, 'NewAppProxy', 'proxy'))
    // permissions
    await acl.createPermission(tap.address, reserve.address, TRANSFER_ROLE, root, { from: root })
    await acl.grantPermission(root, reserve.address, TRANSFER_ROLE, { from: root })
    await acl.createPermission(authorized, tap.address, UPDATE_RESERVE_ROLE, root, { from: root })
    await acl.createPermission(authorized, tap.address, UPDATE_BENEFICIARY_ROLE, root, { from: root })
    await acl.createPermission(authorized, tap.address, UPDATE_MAXIMUM_TAP_INCREASE_RATE_ROLE, root, { from: root })
    await acl.createPermission(authorized, tap.address, ADD_TAPPED_TOKEN_ROLE, root, { from: root })
    await acl.createPermission(authorized, tap.address, REMOVE_TAPPED_TOKEN_ROLE, root, { from: root })
    await acl.createPermission(authorized, tap.address, UPDATE_TAPPED_TOKEN_ROLE, root, { from: root })
    await acl.createPermission(authorized, tap.address, WITHDRAW_ROLE, root, { from: root })
    // initializations
    await reserve.initialize()
    await beneficiary.initialize()
    await tap.initialize(controller.address, reserve.address, beneficiary.address, BATCH_BLOCKS, MAX_TAP_INCREASE_PCT)
    // balances
    await forceSendETH(reserve.address, INITIAL_ETH_BALANCE)
    token1 = await TokenMock.new(reserve.address, INITIAL_TOKEN_BALANCE)
    token2 = await TokenMock.new(reserve.address, INITIAL_TOKEN_BALANCE)
  }

  before(async () => {
    // factory
    const kBase = await Kernel.new(true) // petrify immediately
    const aBase = await ACL.new()
    const rFact = await EVMScriptRegistryFactory.new()
    factory = await DAOFactory.new(kBase.address, aBase.address, rFact.address)
    // base contracts
    controller = await Controller.new()
    vBase = await Vault.new()
    tBase = await Tap.new()
    // constants
    ETH = await (await EtherTokenConstantMock.new()).getETHConstant()
    APP_MANAGER_ROLE = await kBase.APP_MANAGER_ROLE()
    TRANSFER_ROLE = await vBase.TRANSFER_ROLE()
    UPDATE_RESERVE_ROLE = await tBase.UPDATE_RESERVE_ROLE()
    UPDATE_BENEFICIARY_ROLE = await tBase.UPDATE_BENEFICIARY_ROLE()
    UPDATE_MAXIMUM_TAP_INCREASE_RATE_ROLE = await tBase.UPDATE_MAXIMUM_TAP_INCREASE_RATE_ROLE()
    ADD_TAPPED_TOKEN_ROLE = await tBase.ADD_TAPPED_TOKEN_ROLE()
    REMOVE_TAPPED_TOKEN_ROLE = await tBase.REMOVE_TAPPED_TOKEN_ROLE()
    UPDATE_TAPPED_TOKEN_ROLE = await tBase.UPDATE_TAPPED_TOKEN_ROLE()
    WITHDRAW_ROLE = await tBase.WITHDRAW_ROLE()
  })

  beforeEach(async () => {
    await initialize()
  })

  context('> #deploy', () => {
    it('it should deploy', async () => {
      await Tap.new()
    })
  })

  // context('> #initialize', () => {
  //   context('> initialization parameters are correct', () => {
  //     it('it should initialize tap', async () => {
  //       assert.equal(await tap.controller(), controller.address)
  //       assert.equal(await tap.reserve(), reserve.address)
  //       assert.equal(await tap.beneficiary(), beneficiary.address)
  //       assert.equal(await tap.batchBlocks(), BATCH_BLOCKS)
  //       assert.equal(await tap.maximumTapIncreaseRate(), MAX_TAP_INCREASE_PCT)
  //     })
  //   })

  //   context('> initialization parameters are not correct', () => {
  //     it('it should revert', async () => {
  //       const dReceipt = await factory.newDAO(root)
  //       const dao = await Kernel.at(getEvent(dReceipt, 'DeployDAO', 'dao'))
  //       const acl = ACL.at(await dao.acl())
  //       await acl.createPermission(root, dao.address, APP_MANAGER_ROLE, root, { from: root })

  //       const _tReceipt = await dao.newAppInstance(TAP_ID, tBase.address, '0x', false)
  //       const _tap = await Tap.at(getEvent(_tReceipt, 'NewAppProxy', 'proxy'))

  //       await assertRevert(() => _tap.initialize(root, reserve.address, beneficiary.address, BATCH_BLOCKS, MAX_TAP_INCREASE_PCT))
  //       await assertRevert(() => _tap.initialize(controller.address, root, beneficiary.address, BATCH_BLOCKS, MAX_TAP_INCREASE_PCT))
  //       await assertRevert(() => _tap.initialize(controller.address, reserve.address, beneficiary.address, 0, MAX_TAP_INCREASE_PCT))
  //     })
  //   })

  //   it('it should revert on re-initialization', async () => {
  //     await assertRevert(() =>
  //       tap.initialize(controller.address, reserve.address, beneficiary.address, BATCH_BLOCKS, MAX_TAP_INCREASE_PCT, { from: authorized })
  //     )
  //   })
  // })

  // context('> #updateReserve', () => {
  //   context('> sender has UPDATE_RESERVE_ROLE', () => {
  //     context('> and new reserve is a contract', () => {
  //       it('it should update reserve', async () => {
  //         const newReserve = await Vault.new()
  //         const receipt = await tap.updateReserve(newReserve.address, { from: authorized })

  //         assertEvent(receipt, 'UpdateReserve')
  //         assert.equal(await tap.reserve(), newReserve.address)
  //       })
  //     })

  //     context('> but new reserve is not a contract', () => {
  //       it('it should revert', async () => {
  //         await assertRevert(() => tap.updateReserve(root, { from: authorized }))
  //       })
  //     })
  //   })

  //   context('> sender does not have UPDATE_RESERVE_ROLE', () => {
  //     it('it should revert', async () => {
  //       const newReserve = await Vault.new()
  //       await assertRevert(() => tap.updateReserve(newReserve.address, { from: unauthorized }))
  //     })
  //   })
  // })

  // context('> #updateBeneficiary', () => {
  //   context('> sender has UPDATE_BENEFICIARY_ROLE', () => {
  //     it('it should update beneficiary', async () => {
  //       const newBeneficiary = await Vault.new()
  //       const receipt = await tap.updateBeneficiary(newBeneficiary.address, { from: authorized })

  //       assertEvent(receipt, 'UpdateBeneficiary')
  //       assert.equal(await tap.beneficiary(), newBeneficiary.address)
  //     })
  //   })

  //   context('> sender does not have UPDATE_BENEFICIARY_ROLE', () => {
  //     it('it should revert', async () => {
  //       const newBeneficiary = await Vault.new()
  //       await assertRevert(() => tap.updateBeneficiary(newBeneficiary.address, { from: unauthorized }))
  //     })
  //   })
  // })

  // context('> #updateMaximumTapIncreaseRate', () => {
  //   context('> sender has UPDATE_MAXIMUM_TAP_INCREASE_RATE_ROLE', () => {
  //     it('it should update maximum tap increase rate', async () => {
  //       const receipt = await tap.updateMaximumTapIncreaseRate(70 * Math.pow(10, 16), { from: authorized })

  //       assertEvent(receipt, 'UpdateMaximumTapIncreaseRate')
  //       assert.equal(await tap.maximumTapIncreaseRate(), 70 * Math.pow(10, 16))
  //     })
  //   })

  //   context('> sender does not have UPDATE_MAXIMUM_TAP_INCREASE_RATE_ROLE', () => {
  //     it('it should revert', async () => {
  //       await assertRevert(() => tap.updateMaximumTapIncreaseRate(70 * Math.pow(10, 16), { from: unauthorized }))
  //     })
  //   })
  // })

  // context('> #addTappedToken', () => {
  //   context('> sender has ADD_TAPPED_TOKEN_ROLE', () => {
  //     context('> and token is ETH or ERC20', () => {
  //       context('> and token is not yet tapped', () => {
  //         context('> and tap rate is above zero', () => {
  //           it('it should add tapped token', async () => {
  //             const receipt1 = await tap.addTappedToken(ETH, 10, 15, { from: authorized })
  //             const receipt2 = await tap.addTappedToken(token1.address, 50, 25, { from: authorized })
  //             const receipt3 = await tap.addTappedToken(token2.address, 100, 40, { from: authorized })

  //             const batchId1 = getBatchId(receipt1)
  //             const batchId2 = getBatchId(receipt2)
  //             const batchId3 = getBatchId(receipt3)

  //             const timestamp1 = getTimestamp(receipt1)
  //             const timestamp2 = getTimestamp(receipt2)
  //             const timestamp3 = getTimestamp(receipt3)

  //             assertEvent(receipt1, 'AddTappedToken')
  //             assertEvent(receipt2, 'AddTappedToken')
  //             assertEvent(receipt3, 'AddTappedToken')

  //             assert.equal(await tap.taps(ETH), 10)
  //             assert.equal(await tap.taps(token1.address), 50)
  //             assert.equal(await tap.taps(token2.address), 100)

  //             assert.equal(await tap.floors(ETH), 15)
  //             assert.equal(await tap.floors(token1.address), 25)
  //             assert.equal(await tap.floors(token2.address), 40)

  //             assert.equal(await tap.lastWithdrawals(ETH), batchId1)
  //             assert.equal(await tap.lastWithdrawals(token1.address), batchId2)
  //             assert.equal(await tap.lastWithdrawals(token2.address), batchId3)

  //             assert.equal(await tap.lastTapUpdates(ETH), timestamp1)
  //             assert.equal(await tap.lastTapUpdates(token1.address), timestamp2)
  //             assert.equal(await tap.lastTapUpdates(token2.address), timestamp3)
  //           })

  //           it('it should re-add tapped token that has been un-tapped', async () => {
  //             const receipt1 = await tap.addTappedToken(token1.address, 50, 30, { from: authorized })
  //             const batchId1 = getBatchId(receipt1)
  //             const timestamp1 = getTimestamp(receipt1)

  //             assertEvent(receipt1, 'AddTappedToken')
  //             assert.equal(await tap.taps(token1.address), 50)
  //             assert.equal(await tap.floors(token1.address), 30)
  //             assert.equal(await tap.lastWithdrawals(token1.address), batchId1)
  //             assert.equal(await tap.lastTapUpdates(token1.address), timestamp1)

  //             await tap.removeTappedToken(token1.address, { from: authorized })
  //             const receipt2 = await tap.addTappedToken(token1.address, 100, 70, { from: authorized })
  //             const batchId2 = getBatchId(receipt2)
  //             const timestamp2 = getTimestamp(receipt2)

  //             assertEvent(receipt2, 'AddTappedToken')
  //             assert.equal(await tap.taps(token1.address), 100)
  //             assert.equal(await tap.floors(token1.address), 70)
  //             assert.equal(await tap.lastWithdrawals(token1.address), batchId2)
  //             assert.equal(await tap.lastTapUpdates(token1.address), timestamp2)
  //           })
  //         })

  //         context('> but tap rate is zero', () => {
  //           it('it should revert', async () => {
  //             await assertRevert(() => tap.addTappedToken(ETH, 0, 4, { from: authorized }))
  //             await assertRevert(() => tap.addTappedToken(token1.address, 0, 5, { from: authorized }))
  //           })
  //         })
  //       })

  //       context('> but token is already tapped', () => {
  //         it('it should revert', async () => {
  //           await tap.addTappedToken(ETH, 10, 25, { from: authorized })
  //           await tap.addTappedToken(token1.address, 50, 40, { from: authorized })

  //           await assertRevert(() => tap.addTappedToken(ETH, 10, 35, { from: authorized }))
  //           await assertRevert(() => tap.addTappedToken(token1.address, 50, 24, { from: authorized }))
  //         })
  //       })
  //     })

  //     context('> but token is not ETH or ERC20', () => {
  //       it('it should revert', async () => {
  //         await assertRevert(() => tap.addTappedToken(root, 50, 10, { from: authorized }))
  //       })
  //     })
  //   })

  //   context('> sender does not have ADD_TAPPED_TOKEN_ROLE', () => {
  //     it('it should revert', async () => {
  //       await assertRevert(() => tap.addTappedToken(ETH, 10, 10, { from: unauthorized }))
  //       await assertRevert(() => tap.addTappedToken(token1.address, 50, 10, { from: unauthorized }))
  //     })
  //   })
  // })

  // context('> #removeTappedToken', () => {
  //   context('> sender has REMOVE_TAPPED_TOKEN_ROLE', () => {
  //     context('> and token is tapped', () => {
  //       it('it should remove tapped token', async () => {
  //         await tap.addTappedToken(ETH, 10, 5, { from: authorized })
  //         await tap.addTappedToken(token1.address, 50, 5, { from: authorized })

  //         const receipt1 = await tap.removeTappedToken(ETH, { from: authorized })
  //         const receipt2 = await tap.removeTappedToken(token1.address, { from: authorized })

  //         assertEvent(receipt1, 'RemoveTappedToken')
  //         assertEvent(receipt2, 'RemoveTappedToken')
  //         assert.equal(await tap.taps(ETH), 0)
  //         assert.equal(await tap.taps(token1.address), 0)
  //         assert.equal(await tap.floors(ETH), 0)
  //         assert.equal(await tap.floors(token1.address), 0)
  //         assert.equal(await tap.lastWithdrawals(ETH), 0)
  //         assert.equal(await tap.lastWithdrawals(token1.address), 0)
  //         assert.equal(await tap.lastTapUpdates(ETH), 0)
  //         assert.equal(await tap.lastTapUpdates(token1.address), 0)
  //       })
  //     })

  //     context('> but token is not tapped', () => {
  //       it('it should revert', async () => {
  //         await assertRevert(async () => tap.removeTappedToken(ETH, { from: authorized }))
  //         await assertRevert(async () => tap.removeTappedToken(token1.address, { from: authorized }))
  //       })
  //     })
  //   })

  //   context('> sender does not have REMOVE_TAPPED_TOKEN_ROLE', () => {
  //     it('it should revert', async () => {
  //       await tap.addTappedToken(ETH, 10, 5, { from: authorized })
  //       await tap.addTappedToken(token1.address, 50, 5, { from: authorized })

  //       await assertRevert(() => tap.removeTappedToken(ETH, { from: unauthorized }))
  //       await assertRevert(() => tap.removeTappedToken(token1.address, { from: unauthorized }))
  //     })
  //   })
  // })

  // context('> #updateTappedToken', () => {
  //   context('> sender has UPDATE_TAPPED_TOKEN_ROLE', () => {
  //     context('> and token is tapped', () => {
  //       context('> and new tap rate is above zero', () => {
  //         context('> and tap increase is within monthly limit', () => {
  //           it('it should update tap rate', async () => {
  //             await tap.addTappedToken(ETH, 10, 5, { from: authorized })
  //             await tap.addTappedToken(token1.address, 50, 5, { from: authorized })
  //             await tap.addTappedToken(token2.address, 100, 5, { from: authorized })
  //             await timeTravel(20)
  //             // maxTapUpdateETH = 10 * (1 + 0.5) ^ 20 = 33252,5673007965
  //             // maxTapUpdateToken1 = 50 * (1 + 0.5) ^ 20 = 166262,836503982
  //             // maxTapUpdateToken2 = 100 * (1 + 0.5) ^ 20 = 332525,673007965

  //             const receipt1 = await tap.updateTappedToken(ETH, 33000, 10, { from: authorized })
  //             const receipt2 = await tap.updateTappedToken(token1.address, 165000, 7, { from: authorized })
  //             const receipt3 = await tap.updateTappedToken(token2.address, 330000, 8, { from: authorized })

  //             assertEvent(receipt1, 'UpdateTappedToken')
  //             assertEvent(receipt2, 'UpdateTappedToken')
  //             assertEvent(receipt3, 'UpdateTappedToken')

  //             assert.equal(await tap.taps(ETH), 33000)
  //             assert.equal(await tap.taps(token1.address), 165000)
  //             assert.equal(await tap.taps(token2.address), 330000)

  //             assert.equal(await tap.floors(ETH), 10)
  //             assert.equal(await tap.floors(token1.address), 7)
  //             assert.equal(await tap.floors(token2.address), 8)

  //             assert.equal(await tap.lastTapUpdates(ETH), getTimestamp(receipt1))
  //             assert.equal(await tap.lastTapUpdates(token1.address), getTimestamp(receipt2))
  //             assert.equal(await tap.lastTapUpdates(token2.address), getTimestamp(receipt3))
  //           })
  //         })

  //         context('> but tap increase is above monthly limit', () => {
  //           it('it should revert', async () => {
  //             await tap.addTappedToken(ETH, 10, 10, { from: authorized })
  //             await tap.addTappedToken(token1.address, 50, 10, { from: authorized })
  //             await timeTravel(20)
  //             // maxTapUpdateETH = 10 * (1 + 0.5) ^ 20 = 33252,5673007965
  //             // maxTapUpdateToken1 = 50 * (1 + 0.5) ^ 20 = 166262,836503982

  //             // await assertRevert(() => tap.updateTappedToken(ETH, 38000, 5, { from: authorized }))
  //             // await assertRevert(() => tap.updateTappedToken(token1.address, 169000, 5, { from: authorized }))
  //           })
  //         })
  //       })

  //       context('> but new tap rate is zero', () => {
  //         it('it should revert', async () => {
  //           await tap.addTappedToken(ETH, 10, 5, { from: authorized })
  //           await tap.addTappedToken(token1.address, 50, 5, { from: authorized })

  //           await assertRevert(() => tap.updateTappedToken(ETH, 0, 5, { from: authorized }))
  //           await assertRevert(() => tap.updateTappedToken(token1.address, 0, 5, { from: authorized }))
  //         })
  //       })
  //     })

  //     context('> but token is not tapped', () => {
  //       it('it should revert', async () => {
  //         await assertRevert(() => tap.updateTappedToken(ETH, 10, 5, { from: authorized }))
  //         await assertRevert(() => tap.updateTappedToken(token1.address, 50, 5, { from: authorized }))
  //       })
  //     })
  //   })

  //   context('> sender does not have UPDATE_TAPPED_TOKEN_ROLE', () => {
  //     it('it should revert', async () => {
  //       await tap.addTappedToken(ETH, 10, 5, { from: authorized })
  //       await tap.addTappedToken(token1.address, 50, 5, { from: authorized })

  //       await assertRevert(() => tap.updateTappedToken(ETH, 9, 10, { from: unauthorized }))
  //       await assertRevert(() => tap.updateTappedToken(token1.address, 49, 10, { from: unauthorized }))
  //     })
  //   })
  // })

  // context('> #withdraw', () => {
  //   context('> sender has WITHDRAW_ROLE', () => {
  //     context('> and token tap exists', () => {
  //       context('> and reserve balance is not zero', () => {
  //         context('> ETH', () => {
  //           it('it should transfer a tapped amount of ETH from reserve to beneficiary', async () => {
  //             const TAP_1 = 10
  //             const TAP_2 = 12

  //             const receipt1 = await tap.addTappedToken(ETH, TAP_1, { from: authorized })
  //             const timestamp1 = getTimestamp(receipt1)
  //             await timeTravel(20)

  //             // first withdrawal
  //             const receipt2 = await tap.withdraw(ETH, { from: authorized })
  //             const timestamp2 = await getTimestamp(receipt2)
  //             const diff1 = timestamp2 - timestamp1

  //             assertEvent(receipt2, 'Withdraw')
  //             assert.equal((await getBalance(reserve.address)).toNumber(), INITIAL_ETH_BALANCE - TAP_1 * diff1)
  //             assert.equal((await getBalance(beneficiary.address)).toNumber(), TAP_1 * diff1)
  //             assert.equal(await tap.lastWithdrawals(ETH), timestamp2)

  //             // let's time travel and update tap
  //             // 2 weeks = 1296000 seconds
  //             await timeTravel(1296000)
  //             await tap.updateTappedToken(ETH, 12, { from: authorized })
  //             // let's withdraw again
  //             const receipt3 = await tap.withdraw(ETH, { from: authorized })
  //             const timestamp3 = await getTimestamp(receipt3)
  //             const diff2 = timestamp3 - timestamp2

  //             assertEvent(receipt3, 'Withdraw')
  //             assert.equal((await getBalance(reserve.address)).toNumber(), INITIAL_ETH_BALANCE - TAP_1 * diff1 - TAP_2 * diff2)
  //             assert.equal((await getBalance(beneficiary.address)).toNumber(), TAP_1 * diff1 + TAP_2 * diff2)
  //             assert.equal(await tap.lastWithdrawals(ETH), timestamp3)
  //           })
  //         })

  //         context('> ERC20', () => {
  //           it('it should transfer a tapped amount of ERC20 from reserve to beneficiary', async () => {
  //             const TAP_1 = 10
  //             const TAP_2 = 12

  //             const receipt1 = await tap.addTappedToken(token1.address, TAP_1, { from: authorized })
  //             const timestamp1 = getTimestamp(receipt1)
  //             await timeTravel(20)

  //             // first withdrawal
  //             const receipt2 = await tap.withdraw(token1.address, { from: authorized })
  //             const timestamp2 = await getTimestamp(receipt2)
  //             const diff1 = timestamp2 - timestamp1

  //             assertEvent(receipt2, 'Withdraw')
  //             assert.equal((await token1.balanceOf(reserve.address)).toNumber(), INITIAL_TOKEN_BALANCE - TAP_1 * diff1)
  //             assert.equal((await token1.balanceOf(beneficiary.address)).toNumber(), TAP_1 * diff1)
  //             assert.equal(await tap.lastWithdrawals(token1.address), timestamp2)

  //             // let's time travel and update tap
  //             // 2 weeks = 1296000 seconds
  //             await timeTravel(1296000)
  //             await tap.updateTappedToken(token1.address, 12, { from: authorized })
  //             // let's withdraw again
  //             const receipt3 = await tap.withdraw(token1.address, { from: authorized })
  //             const timestamp3 = await getTimestamp(receipt3)
  //             const diff2 = timestamp3 - timestamp2

  //             assertEvent(receipt3, 'Withdraw')
  //             assert.equal((await token1.balanceOf(reserve.address)).toNumber(), INITIAL_TOKEN_BALANCE - TAP_1 * diff1 - TAP_2 * diff2)
  //             assert.equal((await token1.balanceOf(beneficiary.address)).toNumber(), TAP_1 * diff1 + TAP_2 * diff2)
  //             assert.equal(await tap.lastWithdrawals(token1.address), timestamp3)
  //           })
  //         })
  //       })

  //       context('> but reserve balance is zero', () => {
  //         it('it should revert', async () => {
  //           const token = await TokenMock.new(reserve.address, 0)
  //           await tap.addTappedToken(token.address, 1000, { from: authorized })
  //           await timeTravel(1296000)

  //           await assertRevert(() => tap.withdraw(token.address, { from: authorized }))
  //         })
  //       })
  //     })

  //     context('> but token tap does not exist', () => {
  //       it('it should revert', async () => {
  //         const token = await TokenMock.new(reserve.address, INITIAL_TOKEN_BALANCE)
  //         await timeTravel(10)

  //         await assertRevert(() => tap.withdraw(token.address, { from: authorized }))
  //       })
  //     })
  //   })

  //   context('> sender does not have WITHDRAW_ROLE', () => {
  //     it('it should revert', async () => {
  //       await tap.addTappedToken(ETH, 2, { from: authorized })
  //       await tap.addTappedToken(token1.address, 2, { from: authorized })
  //       await timeTravel(10)

  //       await assertRevert(() => tap.withdraw(ETH, { from: unauthorized }))
  //       await assertRevert(() => tap.withdraw(token1.address, { from: unauthorized }))
  //     })
  //   })
  // })

  // context('> #tapIncreaseIsValid', () => {
  //   context('> tap increase is valid', () => {
  //     it('it should return true', async () => {
  //       const INITIAL_TAP = 100

  //       await tap.addTappedToken(token1.address, INITIAL_TAP, { from: authorized })
  //       await timeTravel(20)
  //       // maxTapUpdate = 100 * (1 + 0.5) ^ 20 = 332525,673007965

  //       assert.equal(await tap.tapIncreaseIsValid(token1.address, 332500), true)
  //     })
  //   })

  //   context('> tap increase is not valid', () => {
  //     it('it should return false', async () => {
  //       const INITIAL_TAP = 100

  //       await tap.addTappedToken(token1.address, INITIAL_TAP, { from: authorized })
  //       await timeTravel(20)
  //       // maxTapUpdate = 100 * (1 + 0.5) ^ 20 = 332525,673007965

  //       assert.equal(await tap.tapIncreaseIsValid(token1.address, 332600), false)
  //     })
  //   })
  // })

  context('> #getMaximumWithdrawal', () => {
    context('tokens to hold + floor is inferior to balance', () => {
      context('> tapped amount + tokens to hold + floor is inferior to balance', () => {
        it('it should return a batched tapped amount', async () => {
          // start a new batch
          await progressToNextBatch()
          // add tapped tokens
          await tap.addTappedToken(ETH, 1, 2, { from: authorized })
          await tap.addTappedToken(token1.address, 2, 3, { from: authorized })
          // move two batches further
          await progressToNextBatch()
          await progressToNextBatch()
          // test maximum withdrawal
          assert.equal((await tap.getMaximumWithdrawal(ETH)).toNumber(), 1 * 2 * BATCH_BLOCKS)
          assert.equal((await tap.getMaximumWithdrawal(token1.address)).toNumber(), 2 * 2 * BATCH_BLOCKS)
          // move of a few blocks in the same batch
          await increaseBlocks(5)
          // test maximum withdrawal
          assert.equal((await tap.getMaximumWithdrawal(ETH)).toNumber(), 1 * 2 * BATCH_BLOCKS)
          assert.equal((await tap.getMaximumWithdrawal(token1.address)).toNumber(), 2 * 2 * BATCH_BLOCKS)
          // move the next batch again
          await progressToNextBatch()
          // test maximum withdrawal
          assert.equal((await tap.getMaximumWithdrawal(ETH)).toNumber(), 1 * 3 * BATCH_BLOCKS)
          assert.equal((await tap.getMaximumWithdrawal(token1.address)).toNumber(), 2 * 3 * BATCH_BLOCKS)
        })
      })

      context('> tapped amount + tokens to hold + floor is superior to balance ', () => {
        it('it should return a smaller batched tapped amount to save enough collateral', async () => {
          // start a new batch
          await progressToNextBatch()
          // add tapped tokens
          await tap.addTappedToken(ETH, INITIAL_ETH_BALANCE / 10, 1500, { from: authorized })
          await tap.addTappedToken(token1.address, INITIAL_TOKEN_BALANCE / 10, 150, { from: authorized })
          // move to next batch
          await progressToNextBatch()
          await progressToNextBatch()
          // test maximum withdrawal
          // mock SimpleMarketMakerController enforces 5 ETH and 10 tokens to be hold
          assert.equal((await tap.getMaximumWithdrawal(ETH)).toNumber(), INITIAL_ETH_BALANCE - 5 - 1500)
          assert.equal((await tap.getMaximumWithdrawal(token1.address)).toNumber(), INITIAL_TOKEN_BALANCE - 10 - 150)
        })
      })
    })

    context('tokens to hold + floor is superior to balance', () => {
      it('it should return zero', async () => {
        // move funds out of the reserve
        // mock SimpleMarketMakerController enforces 5 ETH and 10 tokens to be hold
        await reserve.transfer(ETH, root, INITIAL_ETH_BALANCE - 1500 - 5)
        await reserve.transfer(token1.address, root, INITIAL_TOKEN_BALANCE - 150 - 10)
        // start a new batch
        await progressToNextBatch()
        // add tapped tokens
        await tap.addTappedToken(ETH, 25, 1500, { from: authorized })
        await tap.addTappedToken(token1.address, 40, 150, { from: authorized })
        // move to next batch
        await progressToNextBatch()
        // test maximum withdrawal
        assert.equal((await tap.getMaximumWithdrawal(ETH)).toNumber(), 0)
        assert.equal((await tap.getMaximumWithdrawal(token1.address)).toNumber(), 0)
      })
    })
  })
})
