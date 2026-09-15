import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePobXml } from "./pob-parser.js";

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PathOfBuilding2>
  <Build level="90" className="Witch" ascendClassName="Infernalist">
    <PlayerStat stat="TotalDPS" value="123456"/>
    <PlayerStat stat="Life" value="4200"/>
  </Build>
  <Items activeItemSet="1">
    <Item id="1">Rarity: RARE
Doom Weave
Vaal Regalia
Energy Shield: 245
Item Level: 82
Implicits: 0
+45 to maximum Life
+30% increased Energy Shield</Item>
    <ItemSet id="1">
      <Slot name="Body Armour" itemId="1"/>
    </ItemSet>
  </Items>
  <Skills activeSkillSet="1">
    <SkillSet id="1">
      <Skill label="Main" slot="Body Armour" enabled="true" mainActiveSkill="1">
        <Gem nameSpec="Fireball" skillId="Fireball" level="20" quality="20" enabled="true"/>
      </Skill>
    </SkillSet>
  </Skills>
  <Tree activeSpec="1">
    <Spec classId="3" ascendClassId="1" nodes="1,2,3"/>
  </Tree>
</PathOfBuilding2>`;

test("parses build-level metadata and PoB's own computed stats", () => {
  const build = parsePobXml(SAMPLE_XML);
  assert.equal(build.className, "Witch");
  assert.equal(build.ascendClassName, "Infernalist");
  assert.equal(build.level, 90);
  assert.deepEqual(build.playerStats, [
    { stat: "TotalDPS", value: 123456 },
    { stat: "Life", value: 4200 },
  ]);
});

test("resolves equipment via the active item set's slots", () => {
  const build = parsePobXml(SAMPLE_XML);
  assert.equal(build.equipment.length, 1);
  const item = build.equipment[0];
  assert.equal(item.slot, "BodyArmour");
  assert.equal(item.name, "Doom Weave");
  assert.equal(item.baseType, "Vaal Regalia");
  assert.equal(item.itemLevel, 82);
  assert.deepEqual(item.mods, ["+45 to maximum Life", "+30% increased Energy Shield"]);
});

test("parses skill gems from the active skill set", () => {
  const build = parsePobXml(SAMPLE_XML);
  assert.equal(build.skills.length, 1);
  assert.equal(build.skills[0].gems[0].nameSpec, "Fireball");
  assert.equal(build.skills[0].gems[0].level, 20);
});

test("parses allocated passive node ids from the active spec", () => {
  const build = parsePobXml(SAMPLE_XML);
  assert.deepEqual(build.passiveTree.allocatedNodeIds, [1, 2, 3]);
  assert.equal(build.passiveTree.classId, 3);
  assert.equal(build.passiveTree.ascendClassId, 1);
});
