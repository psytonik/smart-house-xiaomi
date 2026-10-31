import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeCloudMap, type VacuumMap } from "../src/vacuumMap.js";
import { roomsOf } from "../src/vacuumRooms.js";
import { cloudMapFile } from "./fakeCloud.js";

/** A 20 x 10 map of 5 cm cells: walls around, room 1 on the left half, room 3 on the right half. */
function twoRooms(width = 20, height = 10): { cells: number[]; width: number; height: number } {
  const cells: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells.push(y === 0 || y === height - 1 || x === 0 || x === width - 1 ? 129 : x < width / 2 ? 1 : 3);
  return { cells, width, height };
}

const mapOf = (cells: number[], width: number, height: number, segments?: VacuumMap["segments"]): VacuumMap => ({ name: "", mapId: 1, width, height, gridMm: 100, leftMm: 0, topMm: 0, cells: Uint8Array.from(cells), ...(segments && { segments }) });

describe("rooms of the saved map", () => {
  it("finds each room, with its area and its middle, and leaves the walls out", () => {
    const { cells, width, height } = twoRooms();
    const rooms = roomsOf(mapOf(cells, width, height));
    assert.deepEqual(rooms.map((r) => [r.id, r.name]), [[1, "Room 1"], [3, "Room 3"]]);
    // 9 columns x 8 rows of floor for room 1 and 9 x 8 for room 3, 10 cm cells = 0.01 m² each
    assert.equal(rooms[0]!.areaM2, 0.7);
    assert.equal(rooms[1]!.areaM2, 0.7);
    assert.ok(rooms[0]!.center.x < rooms[1]!.center.x, "room 1 is on the left");
  });

  it("names a room by its kind, and numbers the kinds that repeat", () => {
    const { cells, width, height } = twoRooms();
    const same = roomsOf(mapOf(cells, width, height, { "1": { type: 2 }, "3": { type: 2 } }));
    assert.deepEqual(same.map((r) => r.name), ["Primary bedroom", "Primary bedroom 2"]);
    const kinds = roomsOf(mapOf(cells, width, height, { "1": { type: 4 }, "3": { type: 6 } }));
    assert.deepEqual(kinds.map((r) => r.name), ["Kitchen", "Bathroom"]);
  });

  it("returns nothing for a map the robot has not been taught rooms on, and ignores specks", () => {
    const { cells, width, height } = twoRooms();
    assert.deepEqual(roomsOf(mapOf(cells.map((c) => (c === 3 ? 1 : c)), width, height)), [], "one segment is the whole home, not a choice");
    const speck = cells.slice();
    speck[width * 4 + 15] = 5; // one cell of a third "room"
    assert.equal(roomsOf(mapOf(speck, width, height)).length, 2);
  });

  it("reads the room kinds from the map file's tail", () => {
    const { cells, width, height } = twoRooms(60, 40); // 5 cm cells: big enough for two real rooms
    const map = decodeCloudMap(cloudMapFile({ width, height, cells, segInf: { "1": { type: 1, nei_id: [3] }, "3": { type: 4, nei_id: [1] } } }));
    assert.deepEqual(roomsOf(map).map((r) => r.name), ["Living room", "Kitchen"]);
    assert.deepEqual(decodeCloudMap(cloudMapFile({ width, height, cells })).segments, { "1": { nei_id: [] } });
  });
});
