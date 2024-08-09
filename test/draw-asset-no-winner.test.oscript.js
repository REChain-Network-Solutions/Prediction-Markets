// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const { expect } = require('chai');
const Decimal = require('decimal.js');
const path = require('path')
const moment = require('moment');

describe('Check prediction AA: 2 (draw-asset-no-winner)', function () {
	this.timeout(120000)
	const { abs, sqrt, ceil, floor } = Math;

	before(async () => {
		this.network = await Network.create()
			.with.agent({ aaLib: path.join(__dirname, "../aa-lib.oscript") })
			.with.agent({ predictionBaseAgent: path.join(__dirname, "../agent.oscript") })
			.with.agent({ predictionFactoryAgent: path.join(__dirname, "../factory.oscript") })
			.with.asset({ reserveAsset: {} })
			.with.wallet({ alice: { base: 50e9, reserveAsset: 10e9 } })
			.with.wallet({ bob: { base: 50e9, reserveAsset: 10e9 } })
			.with.wallet({ oracleOperator: 50e9 })
			.run();

		this.reserve_asset = this.network.asset.reserveAsset;
		this.alice = this.network.wallet.alice;
		this.aliceAddress = await this.alice.getAddress();

		this.bob = this.network.wallet.bob;
		this.bobAddress = await this.bob.getAddress();

		this.oracleOperator = this.network.wallet.oracleOperator;
		this.oracleOperatorAddress = await this.oracleOperator.getAddress();

		this.waiting_period_length = 3 * 24 * 3600;
		this.current_timestamp = Math.floor(Date.now() / 1000);
		this.event_date = this.current_timestamp + 30 * 24 * 3600;

		this.coef = 1;

		this.feed_name = "FEED_NAME";
		this.datafeed_value = 'YES';
		this.issue_fee = 0.01;
		this.redeem_fee = 0.02;
		this.supply_yes = 0;
		this.supply_no = 0;
		this.supply_draw = 0;
		this.reserve = 0;

		this.alice_yes_amount = 0;
		this.alice_no_amount = 0;
		this.alice_draw_amount = 0;

		this.allow_draw = true;
		this.arb_profit_tax = 0.8;

		this.network_fee = (this.reserve_asset == 'base' ? 10000 : 0);

		this.check_reserve = () => {
			expect(ceil(this.coef * sqrt(this.supply_yes ** 2 + this.supply_no ** 2 + this.supply_draw ** 2))).to.be.oneOf([this.reserve, this.reserve + 1]);
		}

		this.buy = (amount_yes, amount_no, amount_draw, readOnly) => {
			const BN = (num) => new Decimal(num);
			const new_reserve = ceil(this.coef * sqrt((this.supply_yes + amount_yes) ** 2 + (this.supply_no + amount_no) ** 2 + (this.supply_draw + amount_draw) ** 2));

			const reserve_delta = new_reserve - this.reserve;
			const reserve_needed = reserve_delta > 0 ? reserve_delta : 0;

			const payout = reserve_delta < 0 ? abs(reserve_delta) : 0;

			let yes_arb_profit_tax = 0;
			let no_arb_profit_tax = 0;
			let draw_arb_profit_tax = 0;

			if (this.supply_yes + this.supply_no + this.supply_draw !== 0) {
				const old_den = sqrt(this.supply_yes ** 2 + this.supply_no ** 2 + this.supply_draw ** 2);

				const new_supply_yes = this.supply_yes + (amount_yes ? amount_yes : 0);
				const new_supply_no = this.supply_no + (amount_no ? amount_no : 0);
				const new_supply_draw = this.supply_draw + (amount_draw ? amount_draw : 0);

				const old_yes_price = this.coef * (this.supply_yes / old_den);
				const old_no_price = this.coef * (this.supply_no / old_den);
				const old_draw_price = this.coef * (this.supply_draw / old_den);

				const new_den = sqrt(new_supply_yes ** 2 + new_supply_no ** 2 + new_supply_draw ** 2);

				const new_yes_price = this.coef * (new_supply_yes / new_den);
				const new_no_price = this.coef * (new_supply_no / new_den);
				const new_draw_price = this.coef * (new_supply_draw / new_den);

				yes_arb_profit_tax = (abs((old_yes_price - new_yes_price) * amount_yes) / 2) * this.arb_profit_tax;
				no_arb_profit_tax = (abs((old_no_price - new_no_price) * amount_no) / 2) * this.arb_profit_tax;
				draw_arb_profit_tax = this.allow_draw ? (abs((old_draw_price - new_draw_price) * amount_draw) / 2) * this.arb_profit_tax : 0;
			}

			const total_arb_profit_tax = yes_arb_profit_tax + no_arb_profit_tax + draw_arb_profit_tax;

			const fee = ceil(reserve_needed * this.issue_fee + payout * this.redeem_fee + total_arb_profit_tax);

			const bn_next_coef = BN(this.coef).mul((new_reserve + fee) / new_reserve).toNumber()

			if (!readOnly) {
				this.reserve = new_reserve + fee;
				this.coef = bn_next_coef;
				this.supply_yes += amount_yes;
				this.supply_no += amount_no;
				this.supply_draw += amount_draw;
			}

			return {
				new_reserve,
				reserve_needed,
				fee,
				payout
			}
		}

		this.get_result_for_buying_by_type = (type, reserve_amount, readOnly = false) => {

			const gross_reserve_delta = reserve_amount - this.network_fee;
			const fee = Math.ceil(gross_reserve_delta * this.issue_fee);

			const old_reserve = this.reserve;
			const new_reserve = old_reserve + gross_reserve_delta;
			const reserve_without_fee = new_reserve - fee;

			const ratio = (reserve_without_fee * reserve_without_fee) / (this.coef * this.coef);

			const supply_yes_squared = this.supply_yes ** 2;
			const supply_no_squared = this.supply_no ** 2;
			const supply_draw_squared = this.supply_draw ** 2;

			if (type == 'yes') {
				prepare_calc = ratio - supply_no_squared - supply_draw_squared;
			} else if (type == 'no') {
				prepare_calc = ratio - supply_yes_squared - supply_draw_squared;
			} else {
				prepare_calc = ratio - supply_yes_squared - supply_no_squared;
			}

			const supply = type == 'yes' ? this.supply_yes : type == 'no' ? this.supply_no : this.supply_draw;
			const amount = floor(sqrt(prepare_calc) - supply);
			const new_supply = supply + amount;
			const new_supply_squared = new_supply * new_supply;

			const new_den = sqrt((type == 'yes' ? new_supply_squared : supply_yes_squared) + (type == 'no' ? new_supply_squared : supply_no_squared) + (type == 'draw' ? new_supply_squared : supply_draw_squared));

			let token_amount;
			let fee_with_arb_profit_tax;
			let arb_profit_tax_amount = 0;

			if (this.reserve !== 0) {
				const old_den = sqrt(supply_yes_squared + supply_no_squared + supply_draw_squared);
				const old_price = this.coef * (supply / old_den);

				const new_price = this.coef * (new_supply / new_den);
				arb_profit_tax_amount = ((abs(old_price - new_price) * amount) / 2) * this.arb_profit_tax;

				fee_with_arb_profit_tax = fee + arb_profit_tax_amount;

				const reserve_without_tax_and_fee = new_reserve - fee_with_arb_profit_tax;
				const new_ratio = (reserve_without_tax_and_fee * reserve_without_tax_and_fee) / (this.coef * this.coef);

				let prepare_calc_2;

				if (type == 'yes') {
					prepare_calc_2 = new_ratio - supply_no_squared - supply_draw_squared;
				} else if (type == 'no') {
					prepare_calc_2 = new_ratio - supply_yes_squared - supply_draw_squared;
				} else {
					prepare_calc_2 = new_ratio - supply_yes_squared - supply_no_squared;
				}

				token_amount = floor(sqrt(prepare_calc_2) - supply);
			} else {
				token_amount = amount;
				fee_with_arb_profit_tax = fee;
			}

			const next_coef = this.coef * new_reserve / (new_reserve - fee_with_arb_profit_tax);

			const yes_price = next_coef * ((type == 'yes' ? supply : this.supply_yes) / new_den);
			const no_price = next_coef * ((type == 'no' ? supply : this.supply_no) / new_den);
			const draw_price = this.allow_draw ? next_coef * ((type == 'draw' ? supply : this.supply_draw) / new_den) : 0;

			const res = ({
				fee: fee_with_arb_profit_tax,
				gross_payout: 0,
				old_coef: this.coef,
				reserve_needed: gross_reserve_delta - fee_with_arb_profit_tax,
				new_reserve: new_reserve,
				arb_profit_tax: arb_profit_tax_amount,
				next_coef: next_coef,
				yes_price: yes_price,
				no_price: no_price,
				draw_price: draw_price,
				amount: token_amount
			});

			if (!readOnly) {
				this.reserve = new_reserve;
				this.coef = next_coef;
				if (type === 'yes') {
					this.supply_yes += token_amount;
				} else if (type === 'no') {
					this.supply_no += token_amount;
				} else {
					this.supply_draw += token_amount;
				}

			}

			return res;
		}

		this.add_liquidity = (reserve_amount, data = {}, readOnly = false) => {
			const gross_reserve_delta = reserve_amount - this.network_fee; // gross, because it includes the fee and tax
			const { yes_amount_ratio = 0, no_amount_ratio = 0 } = data;

			let yes_amount;
			let no_amount;
			let draw_amount;

			if (this.supply_yes + this.supply_no + this.supply_draw === 0) {
				const draw_amount_ratio = 1 - yes_amount_ratio - no_amount_ratio;

				yes_amount = Math.floor(gross_reserve_delta * Math.sqrt(yes_amount_ratio));
				no_amount = Math.floor(gross_reserve_delta * Math.sqrt(no_amount_ratio));
				draw_amount = this.allow_draw ? Math.floor(gross_reserve_delta * Math.sqrt(draw_amount_ratio)) : 0;

			} else {
				const ratio = (gross_reserve_delta + this.reserve) / this.reserve;

				yes_amount = floor(ratio * this.supply_yes - this.supply_yes);
				no_amount = floor(ratio * this.supply_no - this.supply_no);
				draw_amount = floor(ratio * this.supply_draw - this.supply_draw);
			}

			if (!readOnly) {

				this.supply_yes += yes_amount;
				this.supply_no += no_amount;

				if (this.allow_draw) {
					this.supply_draw += draw_amount;
				}

				const target_new_reserve = Math.ceil(this.coef * Math.sqrt(this.supply_yes ** 2 + this.supply_no ** 2 + this.supply_draw ** 2));
				const new_reserve = this.reserve + gross_reserve_delta;

				const rounding_fee = this.reserve + gross_reserve_delta - target_new_reserve;

				this.reserve = new_reserve;

				const next_coef = this.coef * new_reserve / (new_reserve - rounding_fee);

				this.coef = next_coef;
			}

			return {
				yes_amount,
				no_amount,
				draw_amount
			}
		}
	});

	it('Create prediction', async () => {
		const { unit, error } = await this.network.wallet.alice.triggerAaWithData({
			toAddress: this.network.agent.predictionFactoryAgent,
			amount: 20000,
			data: {
				event: "New year",
				oracle: this.oracleOperatorAddress,
				comparison: "==",
				feed_name: this.feed_name,
				allow_draw: this.allow_draw,
				datafeed_value: this.datafeed_value,
				event_date: moment.unix(this.event_date).utc().format('YYYY-MM-DDTHH:mm:ss'),
				waiting_period_length: this.waiting_period_length,
				reserve_asset: this.reserve_asset,
				arb_profit_tax: this.arb_profit_tax
			}
		});

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		expect(response.bounced).to.be.false;

		expect(response.response.responseVars.prediction_address).to.exist;

		this.prediction_address = response.response.responseVars.prediction_address;

		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);
		const { vars: vars2 } = await this.bob.readAAStateVars(this.network.agent.predictionFactoryAgent);

		expect(vars1.yes_asset).to.exist;
		expect(vars1.no_asset).to.exist;
		expect(vars1.draw_asset).to.exist;

		const params = vars2[`prediction_${this.prediction_address}`];

		expect(params.yes_asset).to.exist;
		expect(params.no_asset).to.exist;
		expect(params.draw_asset).to.exist;

		expect(params.yes_asset).to.be.equal(vars1.yes_asset);
		expect(params.no_asset).to.be.equal(vars1.no_asset);
		expect(params.draw_asset).to.be.equal(vars1.draw_asset);

		this.yes_asset = vars1.yes_asset;
		this.no_asset = vars1.no_asset;
		this.draw_asset = vars1.draw_asset;
	});

	it('Alice issue tokens', async () => {
		const yes_amount = 0.5 * 1e9;
		const no_amount = 0.5 * 1e9;
		const draw_amount = 0.5 * 1e9;

		const amount = 1e9;

		const { unit, error } = await this.alice.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					yes_amount,
					no_amount,
					draw_amount
				}
			}]
		})

		const res = this.buy(yes_amount, no_amount, draw_amount);

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		await this.network.witnessUntilStable(response.response_unit);

		expect(response.bounced).to.be.false;

		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);
		expect(vars1.supply_yes).to.be.equal(yes_amount);
		expect(vars1.supply_no).to.be.equal(no_amount);
		expect(vars1.supply_draw).to.be.equal(draw_amount);
		expect(vars1.reserve).to.be.equal(this.reserve);

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				asset: this.yes_asset,
				amount: yes_amount,
			},
			{
				address: this.aliceAddress,
				asset: this.no_asset,
				amount: no_amount,
			},
			{
				address: this.aliceAddress,
				asset: this.draw_asset,
				amount: draw_amount,
			},
			{
				address: this.aliceAddress,
				asset: this.reserve_asset,
				amount: amount - res.reserve_needed - res.fee
			},
		]);

		this.alice_yes_amount += yes_amount;
		this.alice_no_amount += no_amount;
		this.alice_draw_amount += draw_amount;

		this.supply_yes = yes_amount;
		this.supply_no = no_amount;
		this.supply_draw = draw_amount;
		this.check_reserve();
	});

	it('Alice issue tokens (not enough reserve)', async () => {
		const yes_amount = 0.0051e9;
		const no_amount = 0.0251e9;
		const draw_amount = 0.0051e9;

		const res = this.buy(yes_amount, no_amount, draw_amount, true);

		const amount = 10001;

		const { unit, error } = await this.alice.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					yes_amount,
					no_amount,
					draw_amount
				}
			}]
		})


		expect(error).to.be.null
		expect(unit).to.be.validUnit

		await this.network.witnessUntilStable(unit);

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit });
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: amount,
				asset: this.reserve_asset
			},
		]);

		expect(response.bounced).to.be.false;
		expect(response.response.responseVars.error).to.equal(`expected reserve amount: ${Math.abs(res.reserve_needed + res.fee)}`);
	});

	it('Alice redeem yes tokens', async () => {
		const yes_amount_redeem = 0.3 * 1e9;
		this.alice_yes_amount -= yes_amount_redeem;

		const res = this.buy(-yes_amount_redeem, 0, 0);

		const { unit, error } = await this.alice.sendMulti({
			asset: this.yes_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount: yes_amount_redeem }],
		});

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		await this.network.witnessUntilStable(unit);

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit });

		expect(vars1.supply_yes).to.be.equal(this.supply_yes);
		expect(vars1.supply_no).to.be.equal(this.supply_no);
		expect(vars1.supply_draw).to.be.equal(this.supply_draw);
		expect(vars1.reserve).to.be.equal(this.reserve);

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				asset: this.reserve_asset,
				amount: res.payout - res.fee
			},
		]);

		this.check_reserve();
	});

	it('Bob issue tokens', async () => {
		const yes_amount = 2432250;
		const no_amount = 142350;
		const draw_amount = 5421500;

		const res = this.buy(yes_amount, no_amount, draw_amount);

		const amount = 150000000;

		const { unit, error } = await this.bob.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					yes_amount,
					no_amount,
					draw_amount
				}
			}]
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);
		await this.network.witnessUntilStable(response.response_unit);

		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);

		expect(vars1.supply_yes).to.be.equal(this.supply_yes);
		expect(vars1.supply_no).to.be.equal(this.supply_no);
		expect(vars1.supply_draw).to.be.equal(this.supply_draw);
		expect(vars1.reserve).to.be.equal(this.reserve);

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				asset: this.yes_asset,
				amount: yes_amount,
			},
			{
				address: this.bobAddress,
				asset: this.no_asset,
				amount: no_amount,
			},
			{
				address: this.bobAddress,
				asset: this.draw_asset,
				amount: draw_amount,
			},
			{
				address: this.bobAddress,
				asset: this.reserve_asset,
				amount: amount - res.reserve_needed - res.fee,
			},
		]);

		this.bob_yes_amount = yes_amount;
		this.bob_no_amount = no_amount;
		this.bob_draw_amount = draw_amount;

		this.check_reserve();
	});

	it('Bob issues tokens after the period expires', async () => {
		const { error } = await this.network.timetravel({ shift: (this.event_date - this.current_timestamp + 100) * 1000 });
		expect(error).to.be.null;

		const yes_amount = 250;
		const no_amount = 250;
		const draw_amount = 150;

		const amount = 1e9;

		const { unit, error: error2 } = await this.bob.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					yes_amount,
					no_amount,
					draw_amount
				}
			}]
		})

		expect(error2).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);

		expect(response.bounced).to.be.false;
		expect(response.response.responseVars.error).to.equal("the trading period is closed");
	});

	it('Bob commit result (without data_value)', async () => {
		const { unit, error } = await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.prediction_address,
			amount: 1e4,
			data: {
				commit: 1
			}
		});

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);

		expect(response.response.error).to.be.equal("data_feed not found");
	});


	it('Alice claim profit (no result)', async () => {
		const { unit, error } = await this.alice.sendMulti({
			asset: this.yes_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount: this.alice_yes_amount }],
			messages: [{
				app: 'data',
				payload: {
					claim_profit: 1
				}
			}]
		});

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		await this.network.witnessUntilStable(response.response_unit);

		expect(response.response.error).to.be.equal("no results yet");
	});

	it('Alice redeems her tokens', async () => {
		const { error: errorTravel } = await this.network.timetravel({ shift: this.waiting_period_length * 1000 });
		expect(errorTravel).to.be.null;

		const { unit, error } = await this.alice.sendMulti({
			asset: this.yes_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount: this.alice_yes_amount }]
		});

		const res = this.buy(-this.alice_yes_amount, 0, 0);

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);
		expect(response.bounced).to.be.false;

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit });
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: res.payout - res.fee,
				asset: this.reserve_asset
			},
		]);

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { vars } = await this.bob.readAAStateVars(this.prediction_address);
		expect(vars.supply_yes).to.be.equal(this.supply_yes);

		this.check_reserve();
	});

	it('Bob add liquidity', async () => {
		const amount = 3e9;

		const { unit, error } = await this.bob.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					add_liquidity: 1
				}
			}]
		});

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { yes_amount, no_amount, draw_amount } = this.add_liquidity(amount);

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);

		await this.network.witnessUntilStable(response.response_unit);

		expect(response.bounced).to.be.false;
		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);

		expect(vars1.supply_yes).to.be.equal(this.supply_yes);
		expect(vars1.supply_no).to.be.equal(this.supply_no);
		expect(vars1.reserve).to.be.equal(this.reserve);
		expect(Number(vars1.coef).toFixed(9)).to.be.equal(Number(this.coef).toFixed(9));

		this.coef = vars1.coef;

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				asset: this.yes_asset,
				amount: yes_amount,
			},
			{
				address: this.bobAddress,
				asset: this.no_asset,
				amount: no_amount,
			},
			{
				address: this.bobAddress,
				asset: this.draw_asset,
				amount: draw_amount,
			}
		]);

		this.bob_no_amount += no_amount;
		this.bob_yes_amount += yes_amount;
		this.bob_draw_amount += draw_amount;

		this.check_reserve();
	});

	after(async () => {
		await this.network.stop()
	})
})
