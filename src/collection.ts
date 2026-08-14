import { registerBlockCollection } from '@wordpress/blocks';

const globalScope = globalThis as typeof globalThis & {
	__wpTypiaCollections?: Record< string, true >;
};

globalScope.__wpTypiaCollections ??= {};

if ( ! globalScope.__wpTypiaCollections[ 'wp-typia-newsletter-connector' ] ) {
	registerBlockCollection( 'wp-typia-newsletter-connector', {
		title:
			'WPTypia Email Service Provider Connector for Newspack Newsletters with Listmonk',
	} );
	globalScope.__wpTypiaCollections[ 'wp-typia-newsletter-connector' ] = true;
}
