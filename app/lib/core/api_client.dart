import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';

import '../app/app_config.dart';

typedef JsonMap = Map<String, dynamic>;

JsonMap objectOf(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};
List<JsonMap> objectList(Object? value) => value is List
    ? value
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList()
    : <JsonMap>[];
String textOf(Object? value, [String fallback = '']) =>
    value?.toString() ?? fallback;

class ApiException implements Exception {
  const ApiException(this.message, {this.code, this.status, this.requestId});
  final String message;
  final String? code;
  final int? status;
  final String? requestId;
  @override
  String toString() => message;
}

/// One bearer transport for every product resource. No caller identity headers.
class ApiClient {
  ApiClient({String? baseUrl, http.Client? client})
    : baseUrl = (baseUrl ?? AppConfig.apiBaseUrl).replaceFirst(
        RegExp(r'/+$'),
        '',
      ),
      _client = client ?? http.Client(),
      _ownsClient = client == null;

  final String baseUrl;
  final http.Client _client;
  final bool _ownsClient;
  String? accessToken;
  VoidCallback? onUnauthorized;

  Uri uri(String path, [Map<String, Object?>? query]) {
    final relative = Uri.parse(path);
    if (relative.hasScheme || relative.hasAuthority) {
      throw const ApiException('API paths must stay on the configured server.');
    }
    final base = Uri.parse(baseUrl);
    final root = base.path.replaceFirst(RegExp(r'/+$'), '');
    final prefix = root.endsWith('/api/v1') ? root : '$root/api/v1';
    final suffix = relative.path.replaceFirst(RegExp(r'^/?api/v1(?=/|$)'), '');
    final parameters = <String, String>{
      ...relative.queryParameters,
      for (final entry in (query ?? <String, Object?>{}).entries)
        if (entry.value != null && entry.value.toString().isNotEmpty)
          entry.key: entry.value.toString(),
    };
    return base.replace(
      path: '$prefix/${suffix.replaceFirst(RegExp(r'^/'), '')}',
      queryParameters: parameters.isEmpty ? null : parameters,
      fragment: null,
    );
  }

  Map<String, String> get headers => {
    'Accept': 'application/json',
    if (accessToken != null) 'Authorization': 'Bearer $accessToken',
  };

  Future<JsonMap> get(String path, {Map<String, Object?>? query}) =>
      _request('GET', path, query: query);
  Future<JsonMap> post(
    String path, {
    Object? body,
    Map<String, String>? headers,
  }) => _request('POST', path, body: body, extraHeaders: headers);
  Future<JsonMap> put(String path, {Object? body}) =>
      _request('PUT', path, body: body);
  Future<JsonMap> patch(String path, {Object? body}) =>
      _request('PATCH', path, body: body);
  Future<void> delete(String path) async {
    await _request('DELETE', path);
  }

  Future<JsonMap> _request(
    String method,
    String path, {
    Object? body,
    Map<String, Object?>? query,
    Map<String, String>? extraHeaders,
  }) async {
    try {
      final request = http.Request(method, uri(path, query))
        ..headers.addAll({...headers, ...?extraHeaders});
      if (body != null) {
        request.headers['Content-Type'] = 'application/json';
        request.body = jsonEncode(body);
      }
      final response = await _client
          .send(request)
          .then(http.Response.fromStream)
          .timeout(const Duration(seconds: 45));
      return await decodeResponse(response);
    } on TimeoutException {
      throw const ApiException(
        'The server took too long to respond. Refresh to check the result before trying again.',
      );
    } on http.ClientException {
      throw const ApiException(
        'Cannot reach your workspace. Check your connection and server address.',
      );
    }
  }

  Future<JsonMap> upload(
    String path, {
    required String fileName,
    required Uint8List bytes,
    String? contentType,
    Map<String, String> fields = const {},
    String? idempotencyKey,
  }) async {
    try {
      final request = http.MultipartRequest('POST', uri(path))
        ..headers.addAll({
          ...headers,
          'Idempotency-Key': idempotencyKey ?? newRequestId(),
        })
        ..fields.addAll(fields)
        ..files.add(
          http.MultipartFile.fromBytes(
            'file',
            bytes,
            filename: fileName,
            contentType: contentType == null
                ? null
                : MediaType.parse(contentType),
          ),
        );
      final response = await _client
          .send(request)
          .then(http.Response.fromStream)
          .timeout(const Duration(minutes: 5));
      return await decodeResponse(response);
    } on TimeoutException {
      throw const ApiException(
        'Upload timed out. Refresh the collection to check whether it finished.',
      );
    } on http.ClientException {
      throw const ApiException(
        'Upload could not reach the server. Check your connection.',
      );
    }
  }

  Future<JsonMap> decodeResponse(http.Response response) async {
    Object? decoded;
    try {
      if (response.bodyBytes.isNotEmpty) {
        decoded = jsonDecode(utf8.decode(response.bodyBytes));
      }
    } on FormatException {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        throw const ApiException('The server returned an unreadable response.');
      }
    }
    final payload = objectOf(decoded);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final sentToken =
          response.request?.headers['Authorization'] ??
          response.request?.headers['authorization'];
      final requestPath = response.request?.url.path ?? '';
      if (response.statusCode == 401 &&
          accessToken != null &&
          sentToken == 'Bearer $accessToken' &&
          !requestPath.endsWith('/auth/sessions') &&
          !requestPath.endsWith('/auth/accounts')) {
        onUnauthorized?.call();
      }
      final detail = payload['detail'];
      final message = payload['message'] is String
          ? payload['message'] as String
          : detail is String
          ? detail
          : response.statusCode == 401
          ? 'Your session has expired. Sign in again.'
          : response.statusCode == 403
          ? 'You do not have permission to do this.'
          : response.statusCode == 422
          ? 'Check the entered values and try again.'
          : 'The request could not be completed (${response.statusCode}).';
      throw ApiException(
        message,
        code: payload['code'] as String?,
        status: response.statusCode,
        requestId: payload['request_id'] as String?,
      );
    }
    if (decoded != null && decoded is! Map) {
      throw const ApiException('The server returned an unexpected response.');
    }
    return payload;
  }

  void close() {
    if (_ownsClient) _client.close();
  }
}

String newRequestId() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}
