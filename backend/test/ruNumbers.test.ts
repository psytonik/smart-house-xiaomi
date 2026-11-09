import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { numberToWords, spellNumbers } from "../src/ruNumbers.js";

describe("spellNumbers", () => {
  it("spells the weather answer", () => {
    assert.equal(spellNumbers("На улице 16 градусов, ощущается как 15 градусов, ветер 2 метра в секунду."), "На улице шестнадцать градусов, ощущается как пятнадцать градусов, ветер два метра в секунду.");
  });
  it("handles minus, percent, time and feminine nouns", () => {
    assert.equal(spellNumbers("-3, влажность 45%"), "минус три, влажность сорок пять процентов");
    assert.equal(spellNumbers("в 22:30"), "в двадцать два тридцать");
    assert.equal(spellNumbers("Через 1 минуту и 2 секунды"), "Через одну минуту и две секунды");
  });
  it("handles hundreds and thousands", () => {
    assert.equal(numberToWords(101), "сто один");
    assert.equal(numberToWords(2025), "две тысячи двадцать пять");
    assert.equal(spellNumbers("осталось 11 минут"), "осталось одиннадцать минут");
  });
  it("leaves text without digits alone", () => {
    assert.equal(spellNumbers("Свет включён."), "Свет включён.");
  });
});
