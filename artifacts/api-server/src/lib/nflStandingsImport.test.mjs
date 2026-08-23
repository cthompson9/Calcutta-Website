import assert from "node:assert/strict";
import test from "node:test";
import {
  NFL_TEAM_CATALOG,
  NflStandingsImportError,
  parseNflStandingsHtml,
  validateNflStandingsTeams,
} from "./nflStandingsImport.ts";

function standingsHtml({ teamCount = 32, clinch = "BAL" } = {}) {
  const teams = Object.entries(NFL_TEAM_CATALOG).slice(0, teamCount);
  const rows = teams
    .map(([abbreviation, team], index) => {
      const marker = abbreviation === clinch ? "<sup>z</sup>" : "";
      const sourceAbbreviation = abbreviation === "ARI"
        ? "AZ"
        : abbreviation === "LAR"
          ? "LA"
          : abbreviation;
      return `<tr>
        <td><source srcset="https://static.www.nfl.com/league/api/clubs/logos/${sourceAbbreviation}">
          <div class="d3-o-club-fullname">${team.name}${marker}</div></td>
        <td>${index % 2}</td><td>${index % 3}</td><td>0</td><td>${(index % 16) + 1}</td>
        <td>0.000</td><td>0</td><td>0</td><td>${index - 16}</td>
      </tr>`;
    })
    .join("");
  return `<table class="d3-o-standings--detailed"><tbody>${rows}</tbody></table>`;
}

test("NFL standings parser resolves all 32 logo identifiers and clinch status", () => {
  const payload = parseNflStandingsHtml(standingsHtml(), 2026);
  assert.equal(payload.teams.length, 32);
  assert.equal(payload.teams.find((team) => team.abbreviation === "BAL")?.playoffStatus, "clinched");
  assert.equal(payload.teams.find((team) => team.abbreviation === "ARI")?.playoffStatus, "alive");
  assert.equal(payload.teams.find((team) => team.abbreviation === "ARI")?.ptDiff, -16);
  assert.match(payload.sourceHash, /^[a-f0-9]{64}$/);
});

test("NFL standings parser rejects partial pages before any database work", () => {
  assert.throws(
    () => parseNflStandingsHtml(standingsHtml({ teamCount: 31 }), 2026),
    (error) =>
      error instanceof NflStandingsImportError &&
      /all 32 teams/i.test(error.message),
  );
});

test("NFL standings parser only records elimination from an explicit marker", () => {
  const payload = parseNflStandingsHtml(
    standingsHtml({ clinch: "ARI" }).replace("<sup>z</sup>", "<sup>e</sup>"),
    2026,
  );
  assert.equal(payload.teams.find((team) => team.abbreviation === "ARI")?.playoffStatus, "eliminated");
});

test("NFL standings validation rejects impossible records and duplicate teams", () => {
  const teams = parseNflStandingsHtml(standingsHtml(), 2026).teams;
  teams[0].wins = 18;
  assert.throws(() => validateNflStandingsTeams(teams), /total games/i);

  teams[0].wins = 0;
  teams[31].abbreviation = teams[0].abbreviation;
  assert.throws(() => validateNflStandingsTeams(teams), /duplicate team/i);
});