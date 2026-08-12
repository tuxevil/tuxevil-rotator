import { rotatorEnv } from "./env.js";
import { normalizeAccountConfig } from "./config-normalize.js";
import { applyAutoConfigDefaults } from "./auto-routing/config.js";
import {
	DEFAULT_QUOTA_POLL_INTERVAL_MS,
	MAX_QUOTA_POLL_INTERVAL_MS,
	MIN_QUOTA_POLL_INTERVAL_MS,
	type Config,
} from "./types.js";

function safeQuotaPollIntervalMs(value: number | undefined): number {
	if (
		value === undefined ||
		!Number.isFinite(value) ||
		value < MIN_QUOTA_POLL_INTERVAL_MS ||
		value > MAX_QUOTA_POLL_INTERVAL_MS
	) {
		return DEFAULT_QUOTA_POLL_INTERVAL_MS;
	}
	return Math.floor(value);
}

function safeStreamRecoveryMaxRetries(value: number | undefined): number {
	if (value === undefined || !Number.isInteger(value) || value < 0) return 2;
	return value;
}

export function applyConfigDefaults(config: Config): Config {
	const auto = config.auto ? applyAutoConfigDefaults(config.auto) : undefined;
	return {
		proxyPort: config.proxyPort || 51200,
		bindHost: config.bindHost || rotatorEnv("BIND_HOST") || "0.0.0.0",
		routingPolicy: config.routingPolicy || "timer-first",
		requestsPerRotation: config.requestsPerRotation || 5,
		rotateOnQuotaDrop: config.rotateOnQuotaDrop ?? 20,
		quotaPollIntervalMs: safeQuotaPollIntervalMs(config.quotaPollIntervalMs),
		maxConcurrentRequestsPerAccount: config.maxConcurrentRequestsPerAccount ?? 1,
		maxConcurrentRequestsPerProjectModel: config.maxConcurrentRequestsPerProjectModel ?? 1,
		projectCircuitBreaker429Threshold: config.projectCircuitBreaker429Threshold ?? 3,
		projectCircuitBreakerWindowMs: config.projectCircuitBreakerWindowMs ?? 10 * 60 * 1000,
		projectCircuitBreakerCooldownMs: config.projectCircuitBreakerCooldownMs ?? 60 * 60 * 1000,
		modelCircuitBreaker429Threshold: config.modelCircuitBreaker429Threshold ?? 3,
		modelCircuitBreakerCooldownMs: config.modelCircuitBreakerCooldownMs ?? 6 * 60 * 60 * 1000,
		dailyAccountSlowRequests: config.dailyAccountSlowRequests ?? 250,
		dailyAccountStopRequests: config.dailyAccountStopRequests ?? 350,
		dailyProjectSlowRequests: config.dailyProjectSlowRequests ?? 900,
		dailyProjectStopRequests: config.dailyProjectStopRequests ?? 1200,
		slowModeJitterMinMs: config.slowModeJitterMinMs ?? 8_000,
		slowModeJitterMaxMs: config.slowModeJitterMaxMs ?? 25_000,
		protectivePauseMs: config.protectivePauseMs ?? 21600000,
		useRequestCountRotationWhenQuotaUnknownOnly: config.useRequestCountRotationWhenQuotaUnknownOnly ?? true,
		tokenBucketEnabled: config.tokenBucketEnabled ?? false,
		tokenBucketMaxTokens: config.tokenBucketMaxTokens ?? 50,
		tokenBucketRefillPerMinute: config.tokenBucketRefillPerMinute ?? 6,
		tokenBucketInitialTokens: config.tokenBucketInitialTokens ?? (config.tokenBucketMaxTokens ?? 50),
		idempotencyEnabled: config.idempotencyEnabled ?? true,
		idempotencyWindowMs: config.idempotencyWindowMs ?? 2000,
		streamRecoveryMaxRetries: safeStreamRecoveryMaxRetries(config.streamRecoveryMaxRetries),
		compressionMode: config.compressionMode ?? "off",
		accounts: config.accounts ? config.accounts.map((account) => ({
			...normalizeAccountConfig(account),
			tier: account.tier || "unknown",
		})) : [],
		auto,
	};
}

export function getDefaultConfig(): Config {
	return applyConfigDefaults({
		proxyPort: 51200,
		accounts: [],
		requestsPerRotation: 5,
		rotateOnQuotaDrop: 20,
		quotaPollIntervalMs: DEFAULT_QUOTA_POLL_INTERVAL_MS,
		maxConcurrentRequestsPerAccount: 1,
		maxConcurrentRequestsPerProjectModel: 1,
		projectCircuitBreaker429Threshold: 3,
		projectCircuitBreakerWindowMs: 10 * 60 * 1000,
		projectCircuitBreakerCooldownMs: 60 * 60 * 1000,
		modelCircuitBreaker429Threshold: 3,
		modelCircuitBreakerCooldownMs: 6 * 60 * 60 * 1000,
		dailyAccountSlowRequests: 250,
		dailyAccountStopRequests: 350,
		dailyProjectSlowRequests: 900,
		dailyProjectStopRequests: 1200,
		slowModeJitterMinMs: 8_000,
		slowModeJitterMaxMs: 25_000,
		protectivePauseMs: 21600000,
		useRequestCountRotationWhenQuotaUnknownOnly: true,
		tokenBucketEnabled: false,
		tokenBucketMaxTokens: 50,
		tokenBucketRefillPerMinute: 6,
		tokenBucketInitialTokens: 50,
		streamRecoveryMaxRetries: 2,
	});
}
