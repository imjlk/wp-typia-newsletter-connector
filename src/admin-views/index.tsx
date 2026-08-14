/* @jsxRuntime classic */
/* @jsx createElement */
import { Button, Notice, Spinner, TextControl } from '@wordpress/components';
import {
	createElement,
	createRoot,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import type { EndpointValidationResult } from '@wp-typia/rest';

import './style.scss';

import type { ListmonkSettingsResponse } from '../types';
import type { ListmonkSettingsCreateRequest } from '../rest/listmonk-settings/api-types';
import {
	createResource as createSettingsResource,
	readResource as readSettingsResource,
} from '../rest/listmonk-settings/api';

type SettingsForm = {
	apiToken: string;
	apiUser: string;
	baseUrl: string;
	defaultFromEmail: string;
	defaultListIds: string;
	defaultTemplateId: string;
	hasApiToken: boolean;
};

type NoticeState = {
	message: string;
	status: 'error' | 'success' | 'warning';
};

const EMPTY_FORM: SettingsForm = {
	apiToken: '',
	apiUser: '',
	baseUrl: '',
	defaultFromEmail: '',
	defaultListIds: '',
	defaultTemplateId: '0',
	hasApiToken: false,
};

function unwrapEndpointData< Req, Res >(
	result: EndpointValidationResult< Req, Res >
): Res {
	if ( result.isValid && typeof result.data !== 'undefined' ) {
		return result.data as Res;
	}

	const firstError = result.errors[ 0 ];
	throw new Error(
		firstError
			? `${ firstError.path }: ${ firstError.expected }`
			: __(
					'The REST response failed validation.',
					'wp-typia-newsletter-connector'
			  )
	);
}

function getErrorMessage( error: unknown ): string {
	if ( error instanceof Error && error.message ) {
		return error.message;
	}

	if ( error && typeof error === 'object' ) {
		const maybeError = error as {
			data?: { message?: unknown };
			message?: unknown;
		};
		if ( typeof maybeError.message === 'string' ) {
			return maybeError.message;
		}
		if ( typeof maybeError.data?.message === 'string' ) {
			return maybeError.data.message;
		}
	}

	return __( 'Something went wrong.', 'wp-typia-newsletter-connector' );
}

function formFromResponse( response: ListmonkSettingsResponse ): SettingsForm {
	return {
		apiToken: '',
		apiUser: response.apiUser,
		baseUrl: response.baseUrl,
		defaultFromEmail: response.defaultFromEmail ?? '',
		defaultListIds: response.defaultListIds.join( ', ' ),
		defaultTemplateId: String( response.defaultTemplateId ?? 0 ),
		hasApiToken: response.hasApiToken,
	};
}

function parseTemplateId( rawValue: string ): number {
	const value = Number.parseInt( rawValue, 10 );
	return Number.isInteger( value ) && value > 0 ? value : 0;
}

function parseListIds( rawValue: string ): number[] {
	const ids = rawValue
		.split( /[,\s]+/ )
		.map( ( value ) => Number.parseInt( value, 10 ) )
		.filter( ( value ) => Number.isInteger( value ) && value > 0 );

	return [ ...new Set( ids ) ];
}

function SettingsApp() {
	const [ form, setForm ] = useState< SettingsForm >( EMPTY_FORM );
	const [ isLoading, setIsLoading ] = useState( true );
	const [ isSaving, setIsSaving ] = useState( false );
	const [ notice, setNotice ] = useState< NoticeState | null >( null );

	useEffect( () => {
		let isMounted = true;

		async function loadSettings() {
			setIsLoading( true );
			try {
				const response = unwrapEndpointData(
					await readSettingsResource( {} )
				);
				if ( isMounted ) {
					setForm( formFromResponse( response ) );
					setNotice( null );
				}
			} catch ( error ) {
				if ( isMounted ) {
					setNotice( {
						message: getErrorMessage( error ),
						status: 'error',
					} );
				}
			} finally {
				if ( isMounted ) {
					setIsLoading( false );
				}
			}
		}

		loadSettings();

		return () => {
			isMounted = false;
		};
	}, [] );

	const updateField = useCallback(
		( key: keyof SettingsForm ) => ( value: string ) => {
			setForm( ( current ) => ( {
				...current,
				[ key ]: value,
			} ) );
		},
		[]
	);

	const tokenHelp = useMemo( () => {
		if ( form.apiToken.trim().length > 0 ) {
			return __(
				'This token will replace the saved token.',
				'wp-typia-newsletter-connector'
			);
		}

		return form.hasApiToken
			? __(
					'A token is saved. Leave this blank to keep it unchanged.',
					'wp-typia-newsletter-connector'
			  )
			: __(
					'Paste a Listmonk API token.',
					'wp-typia-newsletter-connector'
			  );
	}, [ form.apiToken, form.hasApiToken ] );

	const saveSettings = useCallback(
		async ( testConnection: boolean ) => {
			setIsSaving( true );
			setNotice( null );

			const request: ListmonkSettingsCreateRequest = {
				apiUser: form.apiUser.trim(),
				baseUrl: form.baseUrl.trim(),
				defaultFromEmail: form.defaultFromEmail.trim(),
				defaultListIds: parseListIds( form.defaultListIds ),
				defaultTemplateId: parseTemplateId( form.defaultTemplateId ),
				testConnection,
			};
			const apiToken = form.apiToken.trim();
			if ( apiToken.length > 0 ) {
				request.apiToken = apiToken;
			}

			try {
				const response = unwrapEndpointData(
					await createSettingsResource( request )
				);
				setForm( formFromResponse( response ) );

				if ( response.connection ) {
					setNotice( {
						message: response.connection.message,
						status: response.connection.ok ? 'success' : 'error',
					} );
				} else {
					setNotice( {
						message: __(
							'Listmonk settings saved.',
							'wp-typia-newsletter-connector'
						),
						status: 'success',
					} );
				}
			} catch ( error ) {
				setNotice( {
					message: getErrorMessage( error ),
					status: 'error',
				} );
			} finally {
				setIsSaving( false );
			}
		},
		[ form ]
	);

	return (
		<div className="wp-typia-newsletter-connector-settings">
			{ notice && (
				<Notice status={ notice.status } isDismissible={ false }>
					{ notice.message }
				</Notice>
			) }
			{ isLoading ? (
				<div className="wp-typia-newsletter-connector-settings__loading">
					<Spinner />
					<span>
						{ __(
							'Loading Listmonk settings…',
							'wp-typia-newsletter-connector'
						) }
					</span>
				</div>
			) : (
				<div className="wp-typia-newsletter-connector-settings__form">
					<TextControl
						__nextHasNoMarginBottom
						label={ __(
							'Listmonk API URL',
							'wp-typia-newsletter-connector'
						) }
						onChange={ updateField( 'baseUrl' ) }
						placeholder="https://listmonk.example.com"
						type="url"
						value={ form.baseUrl }
					/>
					<TextControl
						__nextHasNoMarginBottom
						autoComplete="off"
						label={ __(
							'API user',
							'wp-typia-newsletter-connector'
						) }
						onChange={ updateField( 'apiUser' ) }
						value={ form.apiUser }
					/>
					<TextControl
						__nextHasNoMarginBottom
						autoComplete="new-password"
						help={ tokenHelp }
						label={ __(
							'API token',
							'wp-typia-newsletter-connector'
						) }
						onChange={ updateField( 'apiToken' ) }
						type="password"
						value={ form.apiToken }
					/>
					<TextControl
						__nextHasNoMarginBottom
						label={ __(
							'Default From email',
							'wp-typia-newsletter-connector'
						) }
						onChange={ updateField( 'defaultFromEmail' ) }
						placeholder="Newsroom <news@example.com>"
						value={ form.defaultFromEmail }
					/>
					<TextControl
						__nextHasNoMarginBottom
						label={ __(
							'Default template ID',
							'wp-typia-newsletter-connector'
						) }
						min={ 0 }
						onChange={ updateField( 'defaultTemplateId' ) }
						type="number"
						value={ form.defaultTemplateId }
					/>
					<TextControl
						__nextHasNoMarginBottom
						help={ __(
							'Separate multiple Listmonk list IDs with commas.',
							'wp-typia-newsletter-connector'
						) }
						label={ __(
							'Default list IDs',
							'wp-typia-newsletter-connector'
						) }
						onChange={ updateField( 'defaultListIds' ) }
						placeholder="1, 2"
						value={ form.defaultListIds }
					/>
					<div className="wp-typia-newsletter-connector-settings__actions">
						<Button
							disabled={ isSaving }
							isBusy={ isSaving }
							onClick={ () => saveSettings( false ) }
							variant="primary"
						>
							{ __(
								'Save settings',
								'wp-typia-newsletter-connector'
							) }
						</Button>
						<Button
							disabled={ isSaving }
							onClick={ () => saveSettings( true ) }
							variant="secondary"
						>
							{ __(
								'Save and test connection',
								'wp-typia-newsletter-connector'
							) }
						</Button>
					</div>
					<p className="wp-typia-newsletter-connector-settings__token-status">
						{ sprintf(
							/* translators: %s is whether an API token is saved. */
							__(
								'API token saved: %s',
								'wp-typia-newsletter-connector'
							),
							form.hasApiToken
								? __( 'yes', 'wp-typia-newsletter-connector' )
								: __( 'no', 'wp-typia-newsletter-connector' )
						) }
					</p>
				</div>
			) }
		</div>
	);
}

const rootElement = document.getElementById(
	'wp-typia-newsletter-connector-settings-root'
);

if ( rootElement ) {
	createRoot( rootElement ).render( <SettingsApp /> );
}
