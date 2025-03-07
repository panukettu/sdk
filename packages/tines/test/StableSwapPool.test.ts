import { BigNumber, BigNumberish } from "@ethersproject/bignumber"
import { getBigNumber, StableSwapRPool, closeValues } from "../src"

const token0 = {
  name: "Token0",
  "address": "0xb7a4F3E9097C08dA09517b5aB877F7a917224ede"
}
const token1 = {
  name: "Token1",
  "address": "0xd0A1E359811322d97991E03f863a0C30C2cF029C"
}
const v = BigNumber.from("0x76329851304572304587")  // random number  ~ 2^80

function expectCloseValues(
  v1: BigNumberish,
  v2: BigNumberish,
  precision: number,
  description = "",
  additionalInfo = ""
) {
  const a = typeof v1 == "number" ? v1 : parseFloat(v1.toString());
  const b = typeof v2 == "number" ? v2 : parseFloat(v2.toString());
  const res = closeValues(a, b, precision);
  if (!res) {
    console.log("Close values expectation failed:", description);
    console.log("v1 =", a);
    console.log("v2 =", b);
    console.log("precision =", Math.abs(a / b - 1), ", expected <", precision);
    if (additionalInfo != "") {
      console.log(additionalInfo);
    }
  }
  expect(res).toBeTruthy();
  return res;
}

function createPool(amountX: BigNumber, amountY: BigNumber, fee = 0.003, 
  decimals0 = 18,
  decimals1 = 18,
  total0 = {elastic: BigNumber.from(1), base: BigNumber.from(1)},
  total1 = {elastic: BigNumber.from(1), base: BigNumber.from(1)}
  ) {
  return new StableSwapRPool(
    "0x253029F0D3593Afd4187500F1CB243F1EceaABAB",
    token0,
    token1,
    fee,
    amountX,
    amountY,
    decimals0,
    decimals1,
    total0,
    total1
  )
}

function checkCurveInvariant(pool: StableSwapRPool, amountIn: number, amountOut: number, direction: boolean) {
  amountIn *= (direction ? pool.decimalsCompensation0 : pool.decimalsCompensation1)
  amountOut *= (direction ? pool.decimalsCompensation1 : pool.decimalsCompensation0)
  const prev_y = parseFloat((direction ? pool.reserve1 : pool.reserve0).toString())
  if (prev_y < amountOut*(1+1e-12)) 
    return true   // precision doens't allow to make the check -- too big swap

  const k = pool.computeK()
  const amountInWithoutFee = (amountIn*(1-pool.fee))
  const x = (direction ? pool.reserve0 : pool.reserve1).add(getBigNumber(amountInWithoutFee))
  const y = (direction ? pool.reserve1 : pool.reserve0).sub(getBigNumber(amountOut))

  const new_k = x.mul(y).mul( x.mul(x).add(y.mul(y)) )
  const diff = new_k.sub(k).abs()
  if (diff.isZero()) return true
  const relative_diff = k.div(diff)
  // if (relative_diff.lt(1e10))
  //   console.log(k.toString(), new_k.toString(), relative_diff.toString())//, diff.toString());
  return relative_diff.gt(1e10)
}

function checkSwap(pool: StableSwapRPool, amountIn: number, direction: boolean): number {
  const {out, gasSpent} = pool.calcOutByIn(amountIn, direction)
  
  expect(gasSpent).toBeDefined()
  expect(gasSpent).not.toBeNaN()
  expect(gasSpent).toBeGreaterThan(0)
  
  expect(out).toBeDefined()
  expect(out).not.toBeNaN()
  expect(out).toBeGreaterThanOrEqual(0)
  expect(checkCurveInvariant(pool, amountIn, out, direction)).toBeTruthy()
  
  const {inp, gasSpent: gasSpent2} = pool.calcInByOut(out, direction)
  
  expect(gasSpent2).toBeDefined()
  expect(gasSpent2).not.toBeNaN()
  expect(gasSpent2).toBeGreaterThan(0)

  expect(inp).toBeDefined()
  expect(inp).not.toBeNaN()
  expect(inp).toBeGreaterThanOrEqual(0)

  const prev_y = parseFloat((direction ? pool.reserve1 : pool.reserve0).toString())
  if (prev_y > out*(1+1e-12)) // else precision doens't allow to make the check -- too big swap
    expectCloseValues(inp, amountIn, 1e-6)

  return out
}

const E33 = getBigNumber(1e33)
function checkPoolPriceCalculation(pool: StableSwapRPool) {
  const price1 = pool.calcCurrentPriceWithoutFee(true)
  const price2 = pool.calcCurrentPriceWithoutFee(false)

  expect(price1).toBeDefined()
  expect(price1).not.toBeNaN()
  expect(price1).toBeGreaterThan(0)

  expect(price2).toBeDefined()
  expect(price2).not.toBeNaN()
  expect(price2).toBeGreaterThan(0)

  expect(Math.abs(price1*price2-1)).toBeLessThan(1e-9)

  let poolScaled = pool
  if (pool.reserve0.lt(E33)) {
    poolScaled = new StableSwapRPool(   // Scale E21 times
      pool.address,
      pool.token0,
      pool.token1,
      pool.fee,
      pool.getRealReserve0().mul(E33),
      pool.getRealReserve1().mul(E33),
      pool.decimals0,
      pool.decimals1,
      pool.total0.rebaseBN,
      pool.total1.rebaseBN
    )    
  }
  const inp = parseFloat(poolScaled.reserve0.toString())/1e15
  const {out} = poolScaled.calcOutByIn(inp/(1-pool.fee), true)
  const expected_price = out/inp
  expect(Math.abs(price1/expected_price - 1)).toBeLessThan(1e-7)
}

function numberPrecision(n: number, precision = 2) {
  if (n == 0) return 0
  const digits = Math.ceil(Math.log10(n))
  if (digits >= precision) return Math.round(n)
  const shift = Math.pow(10, precision - digits)
  return Math.round(n*shift)/shift
}

describe("StableSwap test", () => {
  describe("calcOutByIn & calcInByOut", () => {
    it('Ideal balance, regular values', () => {
      const pool = createPool(
        v, v.mul(1e6), 0.003, 12, 18,
        {elastic: getBigNumber(1.03*1e18), base: getBigNumber(2e18)},
        {elastic: getBigNumber(1.03*1e18), base: getBigNumber(2e18)}
      )
      for (let i = 0; i < 100; ++i) {
        const amountIn = 1e18*i
        const out1 = checkSwap(pool, amountIn, true)/1e6
        const out2 = checkSwap(pool, amountIn*1e6, false)

        expectCloseValues(out1, out2, 1e-10)
        expect(out1).toBeLessThanOrEqual(amountIn*0.9970000001)
      }
    })
    it('total is 0', () => {
      const v01 = [BigNumber.from(0), BigNumber.from(1)]
      function totalZero(n: number) {
        return {elastic: v01[(n>>1)%2], base: v01[n%2]}
      }
      for (let j = 0; j < 16; ++j) {
        const pool = createPool(
          v, v, 0.003, 6, 6,
          totalZero(j),
          totalZero(j>>2)
        )
        for (let i = 50; i < 53; ++i) {
          const amountIn = 1e18*i
          const out1 = checkSwap(pool, amountIn, true)
          const out2 = checkSwap(pool, amountIn, false)

          expect(out1).toEqual(out2)
          expect(out1).toBeLessThanOrEqual(amountIn*0.997)
        }
      }
    })
    it('Small disbalance, regular values', () => {
      const pool = createPool(
        v.add(v.div(10)), v.mul(1e12), 0.003, 6, 18,
        {elastic: getBigNumber(0.8*1e18), base: getBigNumber(0.95*1e18)},
        {elastic: getBigNumber(0.8*1e18), base: getBigNumber(0.95*1e18)}
      )
      for (let i = 0; i < 100; ++i) {
        const amountIn = 1e18*i
        const out1 = checkSwap(pool, amountIn, true)/1e12
        const out2 = checkSwap(pool, amountIn*1e12, false)

        expect(out1).toBeLessThanOrEqual(out2)
      }
    })
    it('Big disbalance, regular values', () => {
      const pool = createPool(v.mul(1e6), v)
      for (let i = 0; i < 100; ++i) {        
        const amountIn = 1e18*i
        const out1 = checkSwap(pool, amountIn, true)
        const out2 = checkSwap(pool, amountIn, false)

        expect(out1).toBeLessThanOrEqual(out2)
      }
    })
    it('Ideal balance, huge swap values', () => {
      const pool = createPool(v.mul(1e12), v, 0.001, 18, 6)

      const maxReserve = parseFloat(v.toString())*1e6
      for (let i = 1; i < 100; ++i) {
        const amountIn = 1e29*i
        const out1 = checkSwap(pool, amountIn*1e6, true)*1e6
        const out2 = checkSwap(pool, amountIn/1e6, false)/1e6

        expectCloseValues(out1, out2, 1e-10)
        expect(out1).toBeLessThanOrEqual(maxReserve)
      }
    })
  })

  describe("Price calculation", () => {
    it('Regular values', () => {
      for (let i = 1; i < 100; ++i) {
        const pool = createPool(v.mul(i), v.mul(100-i).mul(1e12), 0.003, 6, 18)
        checkPoolPriceCalculation(pool)
      }
    })

    // 1e8->1e2 if 18 decimals
    it('Extreme low balance', () => {    
      const low_v = BigNumber.from(1e8)
      for (let i = 1; i < 100; ++i) {
        const pool = createPool(low_v.mul(i).mul(1e4), low_v.mul(100-i), 0.001, 10, 6)
        checkPoolPriceCalculation(pool)
      }
    })

    it('Extreme disproportion', () => {
      for (let i = 1; i < 100; ++i) {
        const pool = createPool(v.mul(i).mul(1e12), v.mul(1e9-i), 0.002, 18, 6)
        checkPoolPriceCalculation(pool)
      }
    })

    it('Total is not 1', () => {
      for (let i = 1; i < 100; ++i) {
        const pool = createPool(
          v.mul(i), v.mul(100-i).mul(1e12), 0.003, 6, 18,
          {elastic: getBigNumber(1.03*1e18), base: getBigNumber(2e18)},
          {elastic: getBigNumber(1.1*1e18), base: getBigNumber(0.9*1e18)}
        )
        checkPoolPriceCalculation(pool)
      }

      for (let i = 1; i < 100; ++i) {
        const pool = createPool(
          v, v.mul(1e6), 0.003, 12, 18,
          {elastic: getBigNumber(1.05*1e18), base: getBigNumber(i*1e17)},
          {elastic: getBigNumber(1.15*1e18), base: getBigNumber((100-i)*1e17)}
        )
        checkPoolPriceCalculation(pool)
      }
    })
  })

  it('special case', () => {
    const pool = createPool(BigNumber.from(5028472782), BigNumber.from(5028350937))
    const {inp} = pool.calcInByOut(47716160591158, true)
    expect(inp).toEqual(Number.POSITIVE_INFINITY)    
  })

  it('super low amount in/out', () => {
    const pool = createPool(v, v, 0.0005)

    const {inp} = pool.calcInByOut(5, true)
    expect(inp).toBeGreaterThanOrEqual(5)

    const {out} = pool.calcOutByIn(5, true)
    expect(out).toBeLessThanOrEqual(5)
  })

  it.skip('timing mesure', () => {
    const pool = createPool(v, v.add(v.div(100)))
    const amountIn = parseInt(v.div(1000).toString())
    const start0 = performance.now()
    for (let i = 0; i < 100; ++i) pool.calcOutByIn(amountIn*i, i%2 == 0)
    const start1 = performance.now()
    for (let i = 0; i < 100; ++i) pool.calcInByOut(amountIn*i, i%2 == 0)
    const start2 = performance.now()
    for (let i = 0; i < 1000; ++i) pool.calcCurrentPriceWithoutFee(i%2 == 0)
    const finish = performance.now()
    const t1 = numberPrecision((start1-start0)/100)
    const t2 = numberPrecision((start2-start1)/100)
    const t3 = numberPrecision((finish-start2)/1000)
    console.log(`StableSwap pool calcOutByIn: ${t1}ms, calcInByOut: ${t2}ms, price: ${t3}ms`);    
  })
})
