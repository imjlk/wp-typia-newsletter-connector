#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import {
	loadDotEnv,
	logStep,
	parseListIds,
	requireEnv,
} from './smoke-lib.mjs';

loadDotEnv('.staging.env');
loadDotEnv();

const rootDir = process.cwd();
const packageJson = JSON.parse(
	fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
);
const pluginSlug = packageJson.name;
const restNamespace = `${pluginSlug}/v1`;
const version = packageJson.version;
const zipPath = path.join(
	rootDir,
	'artifacts',
	`${pluginSlug}-${version}.zip`
);

const wpBaseUrl = normalizeBaseUrl(requireEnv('STAGING_WP_URL'));
const wpUser = requireEnv('STAGING_WP_USER');
const wpApplicationPassword = requireEnv(
	'STAGING_WP_APPLICATION_PASSWORD'
).replace(/\s+/g, '');
const listmonkBaseUrl = normalizeBaseUrl(
	requireEnv('STAGING_LISTMONK_BASE_URL')
);
const listmonkUser = requireEnv('STAGING_LISTMONK_API_USER');
const listmonkToken = requireEnv('STAGING_LISTMONK_API_TOKEN');
const stagingListIds = parseStagingListIds(
	requireEnv('STAGING_LISTMONK_DEFAULT_LIST_IDS')
);
const stagingFromEmail = requireEnv('STAGING_LISTMONK_FROM_EMAIL');
const stagingTemplateId = parseOptionalInteger(
	process.env.STAGING_LISTMONK_TEMPLATE_ID,
	'STAGING_LISTMONK_TEMPLATE_ID'
);
const stagingTestEmail = (process.env.STAGING_SMOKE_TEST_EMAIL || '').trim();

const wpAuthHeader = `Basic ${Buffer.from(
	`${wpUser}:${wpApplicationPassword}`
).toString('base64')}`;
const listmonkAuthHeader = `Basic ${Buffer.from(
	`${listmonkUser}:${listmonkToken}`
).toString('base64')}`;

const smokeSummary = {
	posts: {},
	campaigns: {},
	notes: [],
};

function normalizeBaseUrl(rawUrl) {
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}

	parsed.hash = '';
	parsed.search = '';
	parsed.pathname = parsed.pathname.replace(/\/+$/, '');
	return parsed.toString().replace(/\/+$/, '');
}

function parseStagingListIds(rawValue) {
	try {
		return parseListIds(rawValue);
	} catch (error) {
		throw new Error(
			`STAGING_LISTMONK_DEFAULT_LIST_IDS must contain at least one positive integer. ${error.message}`
		);
	}
}

function parseOptionalInteger(rawValue, envName) {
	if (!rawValue || rawValue.trim() === '') {
		return 0;
	}

	const value = Number.parseInt(rawValue, 10);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${envName} must be a non-negative integer.`);
	}

	return value;
}

function wpUrl(restPath) {
	const base = new URL(wpBaseUrl);
	const sitePath = base.pathname.replace(/\/+$/, '');
	return new URL(
		`${sitePath}/wp-json/${restPath.replace(/^\/+/, '')}`,
		base.origin
	);
}

function listmonkUrl(apiPath) {
	const base = new URL(listmonkBaseUrl);
	const sitePath = base.pathname.replace(/\/+$/, '');
	const normalizedPath = apiPath.replace(/^\/+/, '');
	const pathWithApi = normalizedPath.startsWith('api/')
		? normalizedPath
		: `api/${normalizedPath}`;
	return new URL(`${sitePath}/${pathWithApi}`, base.origin);
}

async function requestJson(url, options = {}) {
	const method = options.method || 'GET';
	const headers = {
		Accept: 'application/json',
		...(options.headers || {}),
	};

	if (options.auth === 'listmonk') {
		headers.Authorization = listmonkAuthHeader;
	} else if (options.auth !== false) {
		headers.Authorization = wpAuthHeader;
	}

	let body;
	if (Object.prototype.hasOwnProperty.call(options, 'body')) {
		headers['Content-Type'] = 'application/json; charset=utf-8';
		body = JSON.stringify(options.body);
	}

	const response = await fetch(url, {
		body,
		headers,
		method,
	});
	const text = await response.text();
	const data = parseJsonResponse(text);

	if (!response.ok) {
		throw new Error(
			[
				`${method} ${redactUrl(url)} failed with HTTP ${response.status}`,
				extractErrorMessage(data),
			]
				.filter(Boolean)
				.join(': ')
		);
	}

	return data;
}

function parseJsonResponse(text) {
	if (!text) {
		return {};
	}

	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function extractErrorMessage(data) {
	if (!data) {
		return '';
	}
	if (typeof data === 'string') {
		return data.slice(0, 500);
	}
	if (typeof data.message === 'string') {
		return data.message;
	}
	if (typeof data.error === 'string') {
		return data.error;
	}

	return JSON.stringify(data).slice(0, 500);
}

function redactUrl(url) {
	const parsed = new URL(url);
	parsed.username = '';
	parsed.password = '';
	return parsed.toString();
}

function wpRest(restPath, options = {}) {
	return requestJson(wpUrl(restPath), options);
}

function listmonkRest(apiPath, options = {}) {
	return requestJson(listmonkUrl(apiPath), {
		...options,
		auth: 'listmonk',
	});
}

function findPlugin(plugins, slug) {
	return plugins.find((plugin) => {
		const pluginFile = String(plugin.plugin || '');
		const textdomain = String(plugin.textdomain || '');
		return (
			pluginFile === `${slug}/${slug}.php` ||
			pluginFile.startsWith(`${slug}/`) ||
			textdomain === slug
		);
	});
}

async function getPlugins() {
	const plugins = await wpRest('/wp/v2/plugins?context=edit&per_page=100');
	if (!Array.isArray(plugins)) {
		throw new Error('WordPress plugins endpoint returned an unexpected payload.');
	}

	return plugins;
}

async function activatePlugin(plugin, label) {
	if (plugin.status === 'active') {
		return plugin;
	}

	console.log(`Activating ${label} (${plugin.plugin})`);
	return wpRest(`/wp/v2/plugins/${encodeURIComponent(plugin.plugin)}`, {
		body: {
			status: 'active',
		},
		method: 'POST',
	});
}

async function ensurePluginsActive() {
	const plugins = await getPlugins();
	const connector = findPlugin(plugins, pluginSlug);
	const newspack = findPlugin(plugins, 'newspack-newsletters');

	if (!connector) {
		throw new Error(
			[
				`WPTypia Email Service Provider Connector for Newspack Newsletters with Listmonk is not installed on staging.`,
				`Built beta zip: ${path.relative(rootDir, zipPath)}`,
				'Upload that zip in WP Admin or install it with WP-CLI, then rerun pnpm run smoke:staging:zip.',
				'WordPress core REST can install WordPress.org slugs, but does not accept arbitrary plugin zip uploads through application-password auth.',
			].join('\n')
		);
	}
	if (!newspack) {
		throw new Error(
			'Newspack Newsletters is not installed on staging. Install it before running the staging smoke.'
		);
	}

	await activatePlugin(newspack, 'Newspack Newsletters');
	await activatePlugin(
		connector,
		'WPTypia Email Service Provider Connector for Newspack Newsletters with Listmonk'
	);
}

async function saveConnectorSettings() {
	const payload = {
		apiToken: listmonkToken,
		apiUser: listmonkUser,
		baseUrl: listmonkBaseUrl,
		defaultFromEmail: stagingFromEmail,
		defaultListIds: stagingListIds,
		defaultTemplateId: stagingTemplateId,
		testConnection: true,
	};

	const response = await wpRest(
		`/${restNamespace}/listmonk-settings`,
		{
			body: payload,
			method: 'POST',
		}
	);

	if (!response.connection?.ok) {
		throw new Error(
			`Listmonk connection test failed: ${
				response.connection?.message || 'unknown error'
			}`
		);
	}
	if (!response.hasApiToken) {
		throw new Error('Settings response does not confirm a stored API token.');
	}
	if (response.baseUrl !== listmonkBaseUrl) {
		throw new Error('Settings response baseUrl does not match staging input.');
	}

	const hydrated = await wpRest(
		`/${restNamespace}/listmonk-settings/item`
	);
	if (!hydrated.hasApiToken) {
		throw new Error('Hydrated settings do not confirm a stored API token.');
	}

	return hydrated;
}

async function selectListmonkProvider() {
	const attempts = [];
	try {
		const settingsResponse = await wpRest('/wp/v2/settings', {
			body: {
				newspack_newsletters_service_provider: 'listmonk',
			},
			method: 'POST',
		});
		attempts.push({
			ok: true,
			route: '/wp/v2/settings',
			value: settingsResponse.newspack_newsletters_service_provider,
		});
	} catch (error) {
		attempts.push({
			error: error.message,
			ok: false,
			route: '/wp/v2/settings',
		});
	}

	return attempts;
}

async function getNewsletterRestBase() {
	const types = await wpRest('/wp/v2/types?context=edit');
	const direct = types.newspack_nl_cpt;
	const inferred = Object.values(types).find((type) => {
		return (
			type.slug === 'newspack_nl_cpt' ||
			type.rest_base === 'newspack_nl_cpt' ||
			/listmonk|newsletter/i.test(String(type.name || type.slug || ''))
		);
	});
	const newsletterType = direct || inferred;

	const restBase = newsletterType?.rest_base || newsletterType?.slug;
	if (!restBase) {
		throw new Error(
			'Unable to discover the Newspack newsletter REST base from /wp/v2/types.'
		);
	}

	return restBase;
}

async function createNewsletter(restBase, label) {
	const stamp = new Date().toISOString();
	const post = await wpRest(`/wp/v2/${restBase}`, {
		body: {
			content: `<!-- wp:paragraph --><p>Staging smoke ${label} newsletter body ${stamp}</p><!-- /wp:paragraph -->`,
			status: 'draft',
			title: `Listmonk staging smoke ${label} ${stamp}`,
		},
		method: 'POST',
	});

	if (!post.id) {
		throw new Error(`Unable to create ${label} newsletter.`);
	}

	smokeSummary.posts[label] = post.id;
	return post.id;
}

async function updateNewsletter(restBase, postId, body) {
	return wpRest(`/wp/v2/${restBase}/${postId}`, {
		body,
		method: 'POST',
	});
}

async function trashNewsletter(restBase, postId) {
	return wpRest(`/wp/v2/${restBase}/${postId}?force=false`, {
		method: 'DELETE',
	});
}

async function syncNewsletter(postId, providerSelectionAttempts) {
	try {
		const response = await wpRest(
			`/${restNamespace}/newsletter-sync`,
			{
				body: {
					postId,
				},
				method: 'POST',
			}
		);

		if (!response.campaignId) {
			throw new Error('Newsletter sync response did not include a campaign ID.');
		}

		return response;
	} catch (error) {
		if (/active Newspack Newsletters provider|inactive_provider/i.test(error.message)) {
			throw new Error(
				[
					'Listmonk is not the active Newspack Newsletters provider.',
					'The smoke attempted to set newspack_newsletters_service_provider through /wp/v2/settings.',
					`Provider selection attempts: ${JSON.stringify(providerSelectionAttempts)}`,
					'If this option is not registered on staging, set it manually with:',
					'wp option update newspack_newsletters_service_provider listmonk',
				].join('\n')
			);
		}

		throw error;
	}
}

async function retrieveNewsletter(postId) {
	return wpRest(`/newspack-newsletters/v1/listmonk/${postId}/retrieve`);
}

async function sendTest(postId, email) {
	return wpRest(`/newspack-newsletters/v1/listmonk/${postId}/test`, {
		body: {
			test_email: email,
		},
		method: 'POST',
	});
}

async function getCampaign(campaignId) {
	const response = await listmonkRest(`/api/campaigns/${campaignId}`);
	return response.data || response;
}

async function ensureTestSubscriber(email) {
	const subscribers = await listmonkRest('/api/subscribers?per_page=all');
	const existing = extractResults(subscribers).find(
		(subscriber) =>
			String(subscriber.email || '').toLowerCase() === email.toLowerCase()
	);
	if (existing) {
		return existing;
	}

	return listmonkRest('/api/subscribers', {
		body: {
			attribs: {},
			email,
			lists: [stagingListIds[0]],
			name: 'Staging Smoke',
			preconfirm_subscriptions: true,
			status: 'enabled',
		},
		method: 'POST',
	});
}

function extractResults(response) {
	const data = response.data || response;
	if (Array.isArray(data)) {
		return data;
	}
	if (Array.isArray(data.results)) {
		return data.results;
	}
	if (Array.isArray(data.subscribers)) {
		return data.subscribers;
	}
	if (Array.isArray(data.lists)) {
		return data.lists;
	}

	return [];
}

async function readCampaignState(postId) {
	const retrieve = await retrieveNewsletter(postId);
	const campaignId = Number.parseInt(
		retrieve.listmonk_campaign_id || retrieve.campaign_id || '0',
		10
	);
	const campaign = campaignId ? await getCampaign(campaignId) : {};

	return {
		campaignId,
		remoteStatus: String(campaign.status || ''),
		sendAt: String(campaign.send_at || ''),
		metaStatus: String(retrieve.listmonk_last_status || ''),
		retrieve,
	};
}

async function pollCampaignState(postId, predicate, label) {
	const startedAt = Date.now();
	let lastState;

	while (Date.now() - startedAt < 60000) {
		lastState = await readCampaignState(postId);
		if (predicate(lastState)) {
			return lastState;
		}
		await new Promise((resolve) => setTimeout(resolve, 3000));
	}

	throw new Error(
		`${label} did not reach the expected state. Last state: ${JSON.stringify(
			lastState
		)}`
	);
}

async function runDraftSync(restBase, providerSelectionAttempts) {
	const postId = await createNewsletter(restBase, 'draft-sync');
	const sync = await syncNewsletter(postId, providerSelectionAttempts);
	const retrieve = await retrieveNewsletter(postId);
	const campaign = await getCampaign(sync.campaignId);

	assertRetrieveShape(retrieve);
	if (campaign.status !== 'draft') {
		throw new Error(`Expected draft sync campaign status draft, got ${campaign.status}.`);
	}

	smokeSummary.campaigns.draftSync = sync.campaignId;
	return {
		campaignId: sync.campaignId,
		postId,
	};
}

function assertRetrieveShape(retrieve) {
	for (const key of [
		'campaign',
		'send_list_id',
		'lists',
		'senderName',
		'senderEmail',
		'supports_multiple_test_recipients',
	]) {
		if (!Object.prototype.hasOwnProperty.call(retrieve, key)) {
			throw new Error(`Retrieve payload is missing key: ${key}`);
		}
	}
	if (!retrieve.supports_multiple_test_recipients) {
		throw new Error('Retrieve payload does not support multiple test recipients.');
	}
}

async function runOptionalTestSend(postId) {
	if (!stagingTestEmail) {
		smokeSummary.notes.push(
			'Skipped test send because STAGING_SMOKE_TEST_EMAIL is not set.'
		);
		return;
	}

	await ensureTestSubscriber(stagingTestEmail);
	const result = await sendTest(postId, stagingTestEmail);
	if (!result.message) {
		throw new Error('Test send response did not include a message.');
	}

	smokeSummary.notes.push(`Test send requested for ${stagingTestEmail}.`);
}

async function runPublish(restBase, providerSelectionAttempts) {
	const postId = await createNewsletter(restBase, 'publish');
	const sync = await syncNewsletter(postId, providerSelectionAttempts);
	smokeSummary.campaigns.publish = sync.campaignId;

	await updateNewsletter(restBase, postId, {
		status: 'publish',
	});

	const state = await pollCampaignState(
		postId,
		(nextState) =>
			nextState.metaStatus === 'running' &&
			['running', 'finished'].includes(nextState.remoteStatus),
		'Published campaign'
	);

	return {
		...state,
		postId,
	};
}

async function runSchedule(restBase, providerSelectionAttempts) {
	const postId = await createNewsletter(restBase, 'schedule');
	const sync = await syncNewsletter(postId, providerSelectionAttempts);
	smokeSummary.campaigns.schedule = sync.campaignId;

	const futureDate = new Date(Date.now() + 60 * 60 * 1000)
		.toISOString()
		.replace(/\.\d{3}Z$/, '');
	await updateNewsletter(restBase, postId, {
		date_gmt: futureDate,
		status: 'future',
	});

	const state = await pollCampaignState(
		postId,
		(nextState) =>
			nextState.metaStatus === 'scheduled' &&
			nextState.remoteStatus === 'scheduled' &&
			nextState.sendAt !== '',
		'Scheduled campaign'
	);

	return {
		...state,
		postId,
	};
}

async function runArchive(restBase, providerSelectionAttempts) {
	const draftPostId = await createNewsletter(restBase, 'archive-draft');
	const draftSync = await syncNewsletter(draftPostId, providerSelectionAttempts);
	smokeSummary.campaigns.archiveDraft = draftSync.campaignId;
	await trashNewsletter(restBase, draftPostId);
	const draftCampaign = await getCampaign(draftSync.campaignId);
	if (draftCampaign.status !== 'draft') {
		throw new Error(
			`Expected archived draft campaign to remain draft, got ${draftCampaign.status}.`
		);
	}

	const scheduledPostId = await createNewsletter(restBase, 'archive-scheduled');
	const scheduledSync = await syncNewsletter(
		scheduledPostId,
		providerSelectionAttempts
	);
	smokeSummary.campaigns.archiveScheduled = scheduledSync.campaignId;
	const futureDate = new Date(Date.now() + 2 * 60 * 60 * 1000)
		.toISOString()
		.replace(/\.\d{3}Z$/, '');
	await updateNewsletter(restBase, scheduledPostId, {
		date_gmt: futureDate,
		status: 'future',
	});
	await pollCampaignState(
		scheduledPostId,
		(nextState) =>
			nextState.metaStatus === 'scheduled' &&
			nextState.remoteStatus === 'scheduled',
		'Archive scheduled campaign setup'
	);
	await trashNewsletter(restBase, scheduledPostId);
	const scheduledCampaign = await getCampaign(scheduledSync.campaignId);
	if (scheduledCampaign.status !== 'draft') {
		throw new Error(
			`Expected archived scheduled campaign to revert to draft, got ${scheduledCampaign.status}.`
		);
	}

	const runningPostId = await createNewsletter(restBase, 'archive-running');
	const runningSync = await syncNewsletter(
		runningPostId,
		providerSelectionAttempts
	);
	smokeSummary.campaigns.archiveRunning = runningSync.campaignId;
	await updateNewsletter(restBase, runningPostId, {
		status: 'publish',
	});
	await pollCampaignState(
		runningPostId,
		(nextState) =>
			nextState.metaStatus === 'running' &&
			['running', 'finished'].includes(nextState.remoteStatus),
		'Archive running campaign setup'
	);
	await trashNewsletter(restBase, runningPostId);
	const runningCampaign = await getCampaign(runningSync.campaignId);
	if (!['running', 'finished'].includes(String(runningCampaign.status || ''))) {
		throw new Error(
			`Expected archived running campaign to stay running or finished, got ${runningCampaign.status}.`
		);
	}
}

async function main() {
	if (!fs.existsSync(zipPath)) {
		throw new Error(
			`Missing beta zip at ${path.relative(
				rootDir,
				zipPath
			)}. Run pnpm run release:zip first.`
		);
	}

	logStep('Checking staging WordPress plugins');
	await ensurePluginsActive();

	logStep('Saving Listmonk settings and testing the staging connection');
	await saveConnectorSettings();

	logStep('Selecting Listmonk as the Newspack provider');
	const providerSelectionAttempts = await selectListmonkProvider();

	logStep('Discovering Newspack newsletter REST base');
	const newsletterRestBase = await getNewsletterRestBase();
	console.log(`Newsletter REST base: ${newsletterRestBase}`);

	logStep('Running draft sync and retrieve checks');
	const draft = await runDraftSync(newsletterRestBase, providerSelectionAttempts);
	await runOptionalTestSend(draft.postId);

	logStep('Running publish transition check');
	await runPublish(newsletterRestBase, providerSelectionAttempts);

	logStep('Running schedule transition check');
	await runSchedule(newsletterRestBase, providerSelectionAttempts);

	logStep('Running archive policy checks');
	await runArchive(newsletterRestBase, providerSelectionAttempts);

	logStep('Staging smoke completed');
	console.log(
		JSON.stringify(
			{
				ok: true,
				...smokeSummary,
				rollback:
					'Review the listed campaign IDs in Listmonk. Pause/cancel staging campaigns if needed, then restore the previous Newspack provider before production use.',
			},
			null,
			2
		)
	);
}

main().catch((error) => {
	console.error(`\nStaging smoke failed:\n${error.message}`);
	process.exit(1);
});
