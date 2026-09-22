const SECRET_PROVIDER_API_VERSION = 1;

export function defineSecretProvider(definition) {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("A secret provider definition must be an object.");
  }
  if (definition.apiVersion !== SECRET_PROVIDER_API_VERSION) {
    throw new TypeError(
      `Unsupported secret provider apiVersion '${definition.apiVersion}'. Expected ${SECRET_PROVIDER_API_VERSION}.`,
    );
  }
  if (typeof definition.name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(definition.name)) {
    throw new TypeError(`Invalid secret provider name: '${definition.name}'.`);
  }
  if (typeof definition.resolve !== "function") {
    throw new TypeError(`Secret provider '${definition.name}' requires resolve(key, context).`);
  }
  return Object.freeze({ ...definition, apiVersion: SECRET_PROVIDER_API_VERSION });
}

export const SECRET_PROVIDER_VERSION = SECRET_PROVIDER_API_VERSION;
