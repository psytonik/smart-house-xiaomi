import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spokenTime } from "../src/spokenTime.js";

const at = (h: number, m: number) => new Date(2026, 10, 9, h, m);

describe("spokenTime", () => {
  it("says 5 pm as people do: «5 часов вечера 11 минут», not «17 часов»", () => {
    assert.equal(spokenTime(at(17, 11)), "5 часов вечера 11 минут");
  });

  it("night, morning, day and evening", () => {
    assert.equal(spokenTime(at(3, 15)), "3 часа ночи 15 минут");
    assert.equal(spokenTime(at(4, 0)), "4 часа утра ровно");
    assert.equal(spokenTime(at(9, 30)), "9 часов утра 30 минут");
    assert.equal(spokenTime(at(11, 59)), "11 часов утра 59 минут");
    assert.equal(spokenTime(at(12, 5)), "12 часов дня 5 минут");
    assert.equal(spokenTime(at(14, 40)), "2 часа дня 40 минут");
    assert.equal(spokenTime(at(16, 59)), "4 часа дня 59 минут");
    assert.equal(spokenTime(at(17, 0)), "5 часов вечера ровно");
    assert.equal(spokenTime(at(23, 45)), "11 часов вечера 45 минут");
  });

  it("midnight is 12 at night, and one o'clock is «1 час»", () => {
    assert.equal(spokenTime(at(0, 0)), "12 часов ночи ровно");
    assert.equal(spokenTime(at(0, 30)), "12 часов ночи 30 минут");
    assert.equal(spokenTime(at(1, 1)), "1 час ночи 1 минута");
    assert.equal(spokenTime(at(13, 21)), "1 час дня 21 минута");
  });

  it("agrees the words with the numbers", () => {
    assert.equal(spokenTime(at(8, 2)), "8 часов утра 2 минуты");
    assert.equal(spokenTime(at(8, 11)), "8 часов утра 11 минут");
    assert.equal(spokenTime(at(21, 22)), "9 часов вечера 22 минуты");
    assert.equal(spokenTime(at(21, 25)), "9 часов вечера 25 минут");
    assert.equal(spokenTime(at(22, 0)), "10 часов вечера ровно");
  });
});
