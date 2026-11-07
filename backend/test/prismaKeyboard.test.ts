import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canType, step, typeAndSearch, type Cell } from "../src/prismaKeyboard.js";

describe("Prisma's on-screen keyboard", () => {
  it("knows what can be typed", () => {
    assert.equal(canType("обитель зла"), true);
    assert.equal(canType("дюна 2"), false);
    assert.equal(canType("matrix"), false);
    assert.equal(canType(""), false);
  });

  it("walks the focus like the TV does: letters keep their column going down, the space bar is under the middle", () => {
    assert.deepEqual(step({ row: 2, col: 6 }, "down"), { row: 3, col: 3 }); // ь → the space bar
    assert.deepEqual(step({ row: 0, col: 0 }, "up"), { row: 0, col: 0 });
    assert.deepEqual(step({ row: 1, col: 11 }, "down"), { row: 2, col: 9 }); // the third row is shorter: the nearest key
  });

  it("types a title and ends on «Поиск»", () => {
    // replay the presses with the focus rule: each OK must land on the next letter of the title
    const letters = "йцукенгшщзхъ" + "ёфывапролджэ" + "ячсмитьбю.";
    const at = (c: Cell) => (c.row < 3 ? letters[c.row === 0 ? c.col : c.row === 1 ? 12 + c.col : 24 + c.col] : c.col === 3 ? " " : c.col === 5 ? "<search>" : "?");
    let cur: Cell = { row: 0, col: 0 };
    let typed = "";
    for (const m of typeAndSearch("обитель зла")) {
      for (let i = 0; i < m.times; i++) {
        if (m.key === "ok") typed += at(cur);
        else cur = step(cur, m.key);
      }
    }
    assert.equal(typed, "обитель зла<search>");
  });
});
