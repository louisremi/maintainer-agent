/** Limits set by the server operator; a repository policy can only lower them. */
export interface HostLimits {
	readonly maxStepLimit: number;
	readonly maxAttemptsCap: number;
	readonly maxJobsPerAuthorPerDay: number;
	readonly maxReviewComments: number;
	readonly maxDiffLines: number;
}

export const DEFAULT_HOST_LIMITS: HostLimits = {
	maxStepLimit: 120,
	maxAttemptsCap: 5,
	maxJobsPerAuthorPerDay: 5,
	maxReviewComments: 50,
	maxDiffLines: 20000,
};
