abstract final class AppConfig {
  static const apiBaseUrl = String.fromEnvironment(
    'BOMESH_API_URL',
    defaultValue: 'http://localhost:8000',
  );
  static const googleClientId = String.fromEnvironment(
    'BOMESH_GOOGLE_CLIENT_ID',
  );
  static const googleServerClientId = String.fromEnvironment(
    'BOMESH_GOOGLE_SERVER_CLIENT_ID',
  );

  static Uri get apiBaseUri => Uri.parse(apiBaseUrl);
  static bool get isConfigured =>
      (apiBaseUri.scheme == 'https' || apiBaseUri.scheme == 'http') &&
      apiBaseUri.host.isNotEmpty;
}
