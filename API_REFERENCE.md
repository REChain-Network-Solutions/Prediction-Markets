# API Reference

Prediction Markets operates mostly on-chain via smart contracts.

## Smart Contract Methods

### createMarket(eventId, options, stakeAmount)
Create a new prediction market.

### participate(marketId, option, amount)
Stake tokens on a market option.

### resolveMarket(marketId, result)
Resolve a market based on the outcome.

### Example (ethers.js)
```js
contract.methods.createMarket(eventId, options, stake).send({ from: user });
```

Off-chain APIs (optional) may be used for event data indexing.
