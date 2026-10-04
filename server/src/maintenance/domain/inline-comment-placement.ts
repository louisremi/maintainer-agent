import type { InlineComment, Review } from "./agent-results";
import type { DiffHunks } from "./diff-hunks";

export interface PlacedReview {
	readonly summary: string;
	readonly comments: readonly InlineComment[];
	readonly unplaced: number;
}

/**
 * Keeps the review comments that sit on lines of the diff, up to a maximum,
 * and folds the others into the summary so that nothing the reviewer said is
 * lost and the forge never rejects the review for an invalid position.
 */
export const InlineCommentPlacement = {
	place(review: Review, hunks: DiffHunks, maxComments: number): PlacedReview {
		const placed: InlineComment[] = [];
		const folded: InlineComment[] = [];
		const seen = new Set<string>();
		for (const c of review.comments) {
			const key = `${c.path}:${c.side}:${c.line}`;
			if (
				placed.length < maxComments &&
				!seen.has(key) &&
				hunks.contains(c.path, c.line, c.side)
			) {
				placed.push(c);
				seen.add(key);
			} else {
				folded.push(c);
			}
		}
		let summary = review.summary.trim();
		if (folded.length) {
			const notes = folded
				.map(
					(c) =>
						`- \`${c.path.replace(/`/g, "")}\` line ${c.line}: ${c.body.replace(/\s+/g, " ").trim()}`,
				)
				.join("\n");
			summary += `\n\n**Further notes**\n\n${notes}`;
		}
		return { summary, comments: placed, unplaced: folded.length };
	},
};
