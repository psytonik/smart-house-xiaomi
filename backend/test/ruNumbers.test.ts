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

describe("dates are read as ordinals", () => {
  it("«9 ноября» is «девятого ноября», not «девять ноября»", () => {
    assert.equal(spellNumbers("Сегодня понедельник, 9 ноября."), "Сегодня понедельник, девятого ноября.");
  });
  it("every day of the month in the genitive", () => {
    const days: Record<number, string> = { 1: "первого", 2: "второго", 3: "третьего", 4: "четвёртого", 7: "седьмого", 8: "восьмого", 10: "десятого", 11: "одиннадцатого", 12: "двенадцатого", 19: "девятнадцатого", 20: "двадцатого", 21: "двадцать первого", 22: "двадцать второго", 23: "двадцать третьего", 30: "тридцатого", 31: "тридцать первого" };
    for (const [d, word] of Object.entries(days)) assert.equal(spellNumbers(`${d} марта`), `${word} марта`, d);
  });
  it("all twelve months", () => {
    for (const m of ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]) assert.equal(spellNumbers(`5 ${m}`), `пятого ${m}`);
  });
  it("does not touch other numbers next to words", () => {
    assert.equal(spellNumbers("9 градусов"), "девять градусов");
    assert.equal(spellNumbers("осталось 9 минут до 9 ноября"), "осталось девять минут до девятого ноября");
  });
});
