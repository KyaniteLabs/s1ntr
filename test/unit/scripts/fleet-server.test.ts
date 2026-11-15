import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const harness = fileURLToPath(new URL('../../fixtures/fleet_server_regressions.py', import.meta.url));

// Regression: dashboard C2-C6 — retained history, judge windows, events and artifacts.
// Found by /qa; recovery evidence: docs/agents/pm-recovery-2026-09-05.md.
describe('fleet collector behavioral regressions', () => {
  for (const scenario of [
    'domain_correction_preserves_history_but_excludes_false_gain',
    'history_projection_keeps_native_hashed_playable_references',
    'history_projection_quarantines_untrusted_artifact_references',
    'explicit_art_feed_keeps_live_score_and_history',
    'missing_retired_archive_is_explicit',
    'unreadable_file_keeps_other_machine_data',
    'failed_publication_preserves_previous_document_and_cleans_temp',
    'failed_transfer_never_publishes_remote_partial_file',
    'corrupt_retired_rows_are_counted',
    'corrupt_files_do_not_hide_valid_judge_verdict',
    'artifact_paths_reject_traversal_and_symlinks',
    'artifact_http_parity_and_containment',
    'refresh_preserves_repeated_moves_and_deduplicates_replicas',
    'snapshot_uses_current_cycle_and_only_scored_ids',
    'scorecard_index_matches_canonical_rows_within_window',
    'quality_admission_keeps_raw_rows_but_filters_unsupported_derivations',
    'unverified_best_keeps_archive_provenance_probe',
    'art_feed_best_playable_path_mirrors_artifact_directory',
    'merge_and_transfer_losses_mark_both_publications_partial',
    'malformed_rankings_do_not_abort_refresh_or_replace_valid_zero',
    'hostile_trend_metadata_preserves_valid_scores_without_crashing',
    'elo_merge_keeps_maximum_across_scalar_and_object_ratings',
    'malformed_graph_identities_drop_without_losing_valid_neighbors',
    'nonfinite_json_files_are_reported_and_never_published_as_json',
    'overflow_json_is_dropped_before_refresh_publication',
    'out_of_range_trend_axes_do_not_count_as_scored',
    'out_of_range_judge_axes_are_counted_as_dropped',
  ]) {
    it(scenario.replaceAll('_', ' '), () => {
      const result = spawnSync('python3', [harness, `FleetRegression.test_${scenario}`, '-v'], {
        encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('Ran 1 test');
      expect(result.stderr).toMatch(/\nOK\s*$/);
    });
  }
});
