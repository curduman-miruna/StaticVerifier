import { loadEndpointIndex } from '../navigation/endpointIndex';
import { buildOpenApiDocumentFromEndpoints, type OpenApiEndpoint } from './openApiModel';

export async function buildOpenApiDocument() {
	const endpoints = await loadEndpointIndex();
	return buildOpenApiDocumentFromEndpoints(endpoints.map((endpoint): OpenApiEndpoint => ({
		side: endpoint.side,
		method: endpoint.method,
		path: endpoint.path,
		source: endpoint.source,
		requestSchema: endpoint.endpoint.requestSchema,
		responseSchema: endpoint.endpoint.responseSchema,
		requestHeaders: endpoint.endpoint.requestHeaders
	})));
}

export { buildOpenApiDocumentFromEndpoints };
