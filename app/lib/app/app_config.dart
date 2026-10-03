abstract final class AppConfig {
  static const apiBaseUrl = String.fromEnvironment(
    'BOTHESIS_API_URL',
    defaultValue: 'http://localhost:8000',
  );
  static const googleClientId = String.fromEnvironment(
    'BOTHESIS_GOOGLE_CLIENT_ID',
  );
  static const googleServerClientId = String.fromEnvironment(
    'BOTHESIS_GOOGLE_SERVER_CLIENT_ID',
  );

  static Uri get apiBaseUri => Uri.parse(apiBaseUrl);
  static bool get isConfigured =>
      (apiBaseUri.scheme == 'https' || apiBaseUri.scheme == 'http') &&
      apiBaseUri.host.isNotEmpty;
}
