import { describe, it, expect, vi, beforeEach } from "vitest";
import { EvolutionIntegration } from "../../../src/core/EvolutionIntegration.js";
import { createExplorationDecisionAdmission } from
	"../../../src/evolution/ExplorationDecisionAdmission.js";

// Mock extractBehavior to return a known behavior vector
vi.mock("../../../src/evolution/BehaviorVectors.js", () => ({
	extractBehavior: vi.fn(() => [0.1, 0.2, 0.3]),
}));

// Mock ContextAccumulation.save so we don't need the real one
vi.mock("../../../src/core/ContextAccumulation.js", () => ({
	ContextAccumulation: { save: vi.fn() },
}));

import { extractBehavior } from "../../../src/evolution/BehaviorVectors.js";
import { ContextAccumulation } from "../../../src/core/ContextAccumulation.js";

function makeMapElites() {
	return {
		insert: vi.fn(),
		insertAdmitted: vi.fn(),
		coverage: vi.fn(() => 0.5),
		getElites: vi.fn(() => []),
	};
}

const digest = (char: string) => char.repeat(64);
const reward = (iteration: number, score = 0.8, domain = "p5") =>
	createExplorationDecisionAdmission({ purpose: "evolution-reward",
		artifactId: `iteration-${iteration}`, role: "generator", domain,
		ownerDecision: "accepted",
		criterionScore: score, artifactDigest: digest("a"), evidenceDigest: digest("b"),
		decisionDigest: digest("c"), criterionDigest: digest("d"), rendered: true,
		identityValid: true, digestMatched: true, degraded: false });

function makeNoveltyArchive() {
	return {
		noveltyScore: vi.fn(() => 0.75),
		// add() must exist on the real NoveltyArchive contract: update() scores the
		// behavior THEN records it so the next iteration is scored against a growing
		// population (B7). A mock without add() does not match reality.
		add: vi.fn(),
	};
}

function makeAestheticModel() {
	return {
		predict: vi.fn(() => 0.6),
		update: vi.fn(),
	};
}

function makeOptions(overrides: Record<string, unknown> = {}) {
	return {
		useMapElites: true,
		maxIterations: 10,
		_mapElites: makeMapElites(),
		_noveltyArchive: makeNoveltyArchive(),
		collabDomain: "p5",
		...overrides,
	} as any;
}

describe("EvolutionIntegration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("computes novelty (and skips mapElites hints) when useMapElites is false but archive exists (B7)", () => {
		// B7: novelty is a real signal on the default path. With useMapElites off
		// the method still scores + records against the novelty archive and returns
		// that score; only MAP-Elites coordination (insert/coverage hints) is skipped.
		const archive = makeNoveltyArchive();
		const options = makeOptions({ useMapElites: false, _noveltyArchive: archive });
		const ei = new EvolutionIntegration(options, null);
		const result = ei.update(1, "code", 0.8, "prompt");
		expect(result).toEqual({ noveltyScore: 0.75, hints: "" });
		expect(archive.noveltyScore).toHaveBeenCalledWith([0.1, 0.2, 0.3]);
		expect(archive.add).toHaveBeenCalledWith([0.1, 0.2, 0.3]);
	});

	it("returns zeroed novelty when useMapElites is false and no archive exists", () => {
		const options = makeOptions({ useMapElites: false, _noveltyArchive: undefined });
		const ei = new EvolutionIntegration(options, null);
		const result = ei.update(1, "code", 0.8, "prompt");
		expect(result).toEqual({ noveltyScore: 0, hints: "" });
	});

	it("calls extractBehavior and computes novelty from archive", () => {
		const archive = makeNoveltyArchive();
		const options = makeOptions({ _noveltyArchive: archive });
		const ei = new EvolutionIntegration(options, null);
		const result = ei.update(3, "function setup() {}", 0.9, "make circles");

		// extractBehavior now receives the collabDomain so synonym domains
		// (shader/tone) map to the right feature extractor instead of zeroing out.
		expect(extractBehavior).toHaveBeenCalledWith("function setup() {}", "p5");
		expect(archive.noveltyScore).toHaveBeenCalledWith([0.1, 0.2, 0.3]);
		expect(result.noveltyScore).toBe(0.75);
	});

	it("inserts into mapElites and returns without hints when coverage is healthy", () => {
		const mapElites = makeMapElites();
		mapElites.coverage.mockReturnValue(0.6);
		const options = makeOptions({
			_mapElites: mapElites,
			_noveltyArchive: undefined,
		});
		const ei = new EvolutionIntegration(options, null);
		const admission = reward(1);
		const result = ei.update(1, "code", 0.8, "prompt", true, admission);

		expect(mapElites.insertAdmitted).toHaveBeenCalledWith(
			"iteration-1", [0.1, 0.2, 0.3], admission);
		expect(result.hints).toBe("");
	});

	it("saves context when coverage is low (<0.3) and iteration > 1 and elites exist", () => {
		const mapElites = makeMapElites();
		mapElites.coverage.mockReturnValue(0.15);
		mapElites.getElites.mockReturnValue([{ id: "e1" }, { id: "e2" }]);
		const options = makeOptions({ _mapElites: mapElites });
		const ei = new EvolutionIntegration(options, null);
		ei.update(3, "code", 0.5, "generate waves");

		expect(ContextAccumulation.save).toHaveBeenCalledTimes(1);
		const saved = (ContextAccumulation.save as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(saved.evaluation.mapElitesCoverage).toBe(0.15);
		expect(saved.evaluation.mapElitesDiversityHint).toContain("15%");
		expect(saved.iteration).toBe(3.1);
	});

	it("does NOT save context when coverage < 0.3 but iteration is 1", () => {
		const mapElites = makeMapElites();
		mapElites.coverage.mockReturnValue(0.1);
		mapElites.getElites.mockReturnValue([{ id: "e1" }]);
		const options = makeOptions({ _mapElites: mapElites });
		const ei = new EvolutionIntegration(options, null);
		ei.update(1, "code", 0.5, "prompt");
		expect(ContextAccumulation.save).not.toHaveBeenCalled();
	});

	it("does NOT save context when the archive is empty (coverage 0)", () => {
		// Empty archive => coverage 0. The unfiltered getElites() accessor is no
		// longer read on this path (#1275).
		const mapElites = makeMapElites();
		mapElites.coverage.mockReturnValue(0);
		const options = makeOptions({ _mapElites: mapElites });
		const ei = new EvolutionIntegration(options, null);
		ei.update(3, "code", 0.5, "prompt");
		expect(ContextAccumulation.save).not.toHaveBeenCalled();
	});

	it("does NOT save context when coverage is >= 0.3", () => {
		const mapElites = makeMapElites();
		mapElites.coverage.mockReturnValue(0.5);
		const options = makeOptions({ _mapElites: mapElites });
		const ei = new EvolutionIntegration(options, null);
		ei.update(3, "code", 0.5, "prompt");
		expect(ContextAccumulation.save).not.toHaveBeenCalled();
	});

	it("feeds behavior into aesthetic model and produces no hint at moderate quality", () => {
		const aestheticModel = makeAestheticModel();
		aestheticModel.predict.mockReturnValue(0.5);
		const options = makeOptions();
		const ei = new EvolutionIntegration(options, aestheticModel);
		const result = ei.update(2, "code", 0.6, "prompt", true, reward(2, 0.6));

		expect(aestheticModel.predict).toHaveBeenCalledWith([0.1, 0.2, 0.3], {
			domain: "p5",
		});
		expect(aestheticModel.update).toHaveBeenCalledWith([
			{ behavior: [0.1, 0.2, 0.3], rating: 3, domain: "p5" },
		]);
		expect(result.hints).toBe("");
	});

	it("produces low-quality hint when aesthetic prediction < 0.3 and iteration > 1", () => {
		const aestheticModel = makeAestheticModel();
		aestheticModel.predict.mockReturnValue(0.2);
		const options = makeOptions();
		const ei = new EvolutionIntegration(options, aestheticModel);
		const result = ei.update(3, "code", 0.4, "prompt");
		expect(result.hints).toContain("low-quality outputs");
		expect(result.hints).toContain("significantly different approach");
	});

	it("does NOT produce low-quality hint at iteration 1", () => {
		const aestheticModel = makeAestheticModel();
		aestheticModel.predict.mockReturnValue(0.1);
		const options = makeOptions();
		const ei = new EvolutionIntegration(options, aestheticModel);
		const result = ei.update(1, "code", 0.4, "prompt");
		expect(result.hints).toBe("");
	});

	it("produces high-quality hint when aesthetic prediction > 0.7", () => {
		const aestheticModel = makeAestheticModel();
		aestheticModel.predict.mockReturnValue(0.85);
		const options = makeOptions();
		const ei = new EvolutionIntegration(options, aestheticModel);
		const result = ei.update(2, "code", 0.9, "prompt");
		expect(result.hints).toContain("high-quality outputs");
		expect(result.hints).toContain("Lean into this direction");
	});

	it("uses collabDomain from options when present", () => {
		const aestheticModel = makeAestheticModel();
		aestheticModel.predict.mockReturnValue(0.8);
		const options = makeOptions({ collabDomain: "glsl" });
		const ei = new EvolutionIntegration(options, aestheticModel);
		ei.update(2, "code", 0.9, "prompt", true, reward(2, 0.9, "glsl"));
		expect(aestheticModel.predict).toHaveBeenCalledWith([0.1, 0.2, 0.3], {
			domain: "glsl",
		});
		expect(aestheticModel.update).toHaveBeenCalledWith([
			{ behavior: [0.1, 0.2, 0.3], rating: 4.5, domain: "glsl" },
		]);
	});

	it("skips aesthetic model when null", () => {
		const options = makeOptions();
		const ei = new EvolutionIntegration(options, null);
		const result = ei.update(2, "code", 0.8, "prompt");
		expect(result.hints).toBe("");
	});

	it("skips novelty archive when undefined", () => {
		const options = makeOptions({ _noveltyArchive: undefined });
		const ei = new EvolutionIntegration(options, null);
		const result = ei.update(2, "code", 0.8, "prompt");
		expect(result.noveltyScore).toBe(0);
	});

	it("skips mapElites when undefined", () => {
		const archive = makeNoveltyArchive();
		const options = makeOptions({
			_mapElites: undefined,
			_noveltyArchive: archive,
		});
		const ei = new EvolutionIntegration(options, null);
		const result = ei.update(2, "code", 0.8, "prompt");
		expect(result.noveltyScore).toBe(0.75);
	});

	// ─── W4: fitness banking gated on scoreIsHonest ───────────────────

	it("W4: still scores novelty when scoreIsHonest=false (degraded)", () => {
		const archive = makeNoveltyArchive();
		const mapElites = makeMapElites();
		const options = makeOptions({ _noveltyArchive: archive, _mapElites: mapElites });
		const ei = new EvolutionIntegration(options, null);
		const result = ei.update(1, "code", 0.99, "prompt", false);

		expect(result.noveltyScore).toBe(0.75);
		expect(archive.noveltyScore).toHaveBeenCalledWith([0.1, 0.2, 0.3]);
		expect(archive.add).toHaveBeenCalledWith([0.1, 0.2, 0.3]);
		// Fitness banking skipped
		expect(mapElites.insert).not.toHaveBeenCalled();
	});

	it("W4: does not bank MAP-Elites fitness when scoreIsHonest=false", () => {
		const mapElites = makeMapElites();
		const options = makeOptions({
			_mapElites: mapElites,
			_noveltyArchive: undefined,
		});
		const ei = new EvolutionIntegration(options, null);
		ei.update(1, "code", 0.99, "prompt", false);
		expect(mapElites.insert).not.toHaveBeenCalled();
	});

	it("requires admitted criterion evidence to bank MAP-Elites fitness", () => {
		const mapElites = makeMapElites();
		const options = makeOptions({
			_mapElites: mapElites,
			_noveltyArchive: undefined,
		});
		const ei = new EvolutionIntegration(options, null);
		ei.update(1, "code", 1, "prompt", true);
		expect(mapElites.insertAdmitted).not.toHaveBeenCalled();
		const admission = reward(1);
		ei.update(1, "code", 0.1, "prompt", true, admission);
		expect(mapElites.insertAdmitted).toHaveBeenCalledWith(
			"iteration-1", [0.1, 0.2, 0.3], admission);
	});

	it("W4: does not train aesthetic model on degraded score", () => {
		const aestheticModel = makeAestheticModel();
		aestheticModel.predict.mockReturnValue(0.5);
		const options = makeOptions();
		const ei = new EvolutionIntegration(options, aestheticModel);
		ei.update(2, "code", 0.99, "prompt", false);

		// predict still runs (reads history; does not bank this score)
		expect(aestheticModel.predict).toHaveBeenCalledTimes(1);
		expect(aestheticModel.update).not.toHaveBeenCalled();
	});

	it("trains aesthetic model only on admitted criterion score", () => {
		const aestheticModel = makeAestheticModel();
		aestheticModel.predict.mockReturnValue(0.5);
		const options = makeOptions();
		const ei = new EvolutionIntegration(options, aestheticModel);
		ei.update(2, "code", 0.1, "prompt", true, reward(2, 0.6));

		expect(aestheticModel.update).toHaveBeenCalledWith([
			{ behavior: [0.1, 0.2, 0.3], rating: 3, domain: "p5" },
		]);
	});
});
