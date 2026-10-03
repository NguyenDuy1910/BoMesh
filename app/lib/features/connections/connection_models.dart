import '../../core/api_client.dart';
import '../auth/session.dart';

String resourcePath(String resource, String id) =>
    '/$resource/${Uri.encodeComponent(id)}';
int countOf(Object? value) => value is num ? value.toInt() : 0;
String readable(String value) => value.isEmpty
    ? 'Unknown'
    : '${value[0].toUpperCase()}${value.substring(1).replaceAll('_', ' ')}';
String dateLabel(Object? value) {
  final date = DateTime.tryParse(textOf(value))?.toLocal();
  if (date == null) return 'Not yet';
  String two(int number) => number.toString().padLeft(2, '0');
  return '${date.year}-${two(date.month)}-${two(date.day)} · ${two(date.hour)}:${two(date.minute)}';
}

String durationLabel(Object? value) {
  if (value is! num) return '—';
  final seconds = value ~/ 1000;
  if (seconds < 60) return '${seconds}s';
  if (seconds < 3600) return '${seconds ~/ 60}m ${seconds % 60}s';
  return '${seconds ~/ 3600}h ${(seconds % 3600) ~/ 60}m';
}

class ResourcePage<T> {
  ResourcePage(JsonMap json, T Function(JsonMap) parse)
    : items = objectList(json['items']).map(parse).toList(),
      page = countOf(json['page']),
      total = countOf(json['total']),
      pageSize = countOf(json['page_size']);
  final List<T> items;
  final int page, total, pageSize;
  bool get hasNext => page * pageSize < total;
}

class ProviderInfo {
  ProviderInfo(JsonMap json)
    : key = textOf(json['connector_key']),
      name = textOf(json['display_name'], textOf(json['connector_key'])),
      providerName = textOf(
        json['provider_display_name'],
        textOf(json['display_name']),
      ),
      authentication = textOf(json['authentication_type']),
      available = json['available'] == true,
      canAuthorize = json['authorization_available'] == true,
      acceptsCredentials = json['accepts_credentials'] == true;
  final String key, name, providerName, authentication;
  final bool available, canAuthorize, acceptsCredentials;
  bool get hasCredentialForm => key == 'confluence';
}

class ConnectionRecord {
  ConnectionRecord(JsonMap json)
    : id = textOf(json['id']),
      connector = textOf(json['connector_key']),
      name = textOf(json['display_name']),
      ownerType = textOf(json['owner_type']),
      ownerUserId = textOf(json['owner_user_id']),
      status = textOf(json['status']),
      statusDetail = textOf(json['status_detail']),
      account = textOf(objectOf(json['account'])['label']),
      accountResource = textOf(objectOf(json['account'])['resource_label']),
      browsable = json['browsable'] == true,
      sourceCount = countOf(json['source_count']),
      config = objectOf(json['config']),
      updatedAt = textOf(json['updated_at']),
      connectedAt = textOf(json['connected_at']),
      checkedAt = textOf(json['last_checked_at']);
  final String id,
      connector,
      name,
      ownerType,
      ownerUserId,
      status,
      statusDetail;
  final String account, accountResource, updatedAt, connectedAt, checkedAt;
  final bool browsable;
  final int sourceCount;
  final JsonMap config;
  bool writable(AuthSession session) => ownerType == 'workspace'
      ? session.can('source.manage')
      : ownerUserId == session.userId;
  String get accountLine =>
      [accountResource, account].where((s) => s.isNotEmpty).join(' · ');
}

class SourceRecord {
  SourceRecord(JsonMap json)
    : id = textOf(json['id']),
      connectionId = textOf(json['connection_id']),
      collectionId = textOf(json['collection_id']),
      name = textOf(json['display_name'], 'Knowledge source'),
      resourceType = textOf(json['resource_type']),
      resourceId = textOf(json['external_resource_id']),
      syncMode = textOf(json['sync_mode']),
      status = textOf(json['status']),
      schedule = json['schedule'] is Map ? objectOf(json['schedule']) : null;
  final String id,
      connectionId,
      collectionId,
      name,
      resourceType,
      resourceId,
      syncMode,
      status;
  final JsonMap? schedule;
}

class ProviderResource {
  ProviderResource(JsonMap json)
    : id = textOf(json['external_id']),
      type = textOf(json['resource_type']),
      name = textOf(json['name']),
      hasChildren = json['has_children'] == true;
  final String id, type, name;
  final bool hasChildren;
  String get selectionKey => '$type:$id';
}

class IngestionRecord {
  IngestionRecord(JsonMap json)
    : id = textOf(json['id']),
      title = textOf(
        json['title'],
        json['kind'] == 'source' ? 'Knowledge source' : 'Document',
      ),
      kind = textOf(json['kind']),
      mode = textOf(json['mode']),
      status = textOf(json['status']),
      trigger = textOf(json['trigger_type']),
      collectionId = textOf(json['collection_id']),
      sourceId = textOf(json['source_id']),
      error = textOf(json['error']),
      attempt = countOf(json['attempt']),
      progress = objectOf(json['progress']),
      startedAt = textOf(json['started_at']),
      finishedAt = textOf(json['finished_at']),
      createdAt = textOf(json['created_at']),
      durationMs = json['duration_ms'] is num
          ? (json['duration_ms'] as num).toInt()
          : null;
  final String id,
      title,
      kind,
      mode,
      status,
      trigger,
      collectionId,
      sourceId,
      error;
  final String startedAt, finishedAt, createdAt;
  final int attempt;
  final int? durationMs;
  final JsonMap progress;
  bool get active => status == 'pending' || status == 'running';
  bool get retryable =>
      const {'failed', 'cancelled', 'timed_out'}.contains(status);
  String get phase => textOf(progress['phase'], status);
  String get progressLabel {
    if (status == 'pending') {
      return attempt > 1 ? 'Waiting to try again' : 'Waiting to start';
    }
    final total = countOf(progress['discovered_count']);
    final done = countOf(
      progress[phase == 'storing' ? 'indexed_count' : 'processed_count'],
    );
    if (total > 0 &&
        const {
          'embedding',
          'storing',
          'expanding',
          'syncing',
        }.contains(phase)) {
      final unit = phase == 'syncing'
          ? 'items'
          : phase == 'expanding'
          ? 'files'
          : 'chunks';
      return '${readable(phase)} $done of $total $unit';
    }
    return readable(phase);
  }

  double? get progressRatio {
    final total = countOf(progress['discovered_count']);
    if (total == 0 ||
        !const {
          'embedding',
          'storing',
          'expanding',
          'syncing',
        }.contains(phase)) {
      return null;
    }
    final done = countOf(
      progress[phase == 'storing' ? 'indexed_count' : 'processed_count'],
    );
    return (done / total).clamp(0.0, 1.0).toDouble();
  }
}

// Mirrors the real web connector metadata. The capability endpoint determines
// availability; these fields only describe adapters implemented in that registry.
class ConnectorField {
  const ConnectorField(
    this.name,
    this.label, {
    this.kind = 'text',
    this.required = false,
    this.help,
    this.initial = '',
  });
  final String name, label, kind;
  final bool required;
  final String? help;
  final Object initial;
}

const confluenceConnectionFields = [
  ConnectorField(
    'wiki_base',
    'Site URL',
    kind: 'url',
    required: true,
    help: 'For example, https://your-team.atlassian.net/wiki',
  ),
  ConnectorField(
    'is_cloud',
    'Atlassian Cloud',
    kind: 'boolean',
    initial: true,
    help: 'Turn off for Confluence Server or Data Center.',
  ),
];
const confluenceCredentialFields = [
  ConnectorField(
    'confluence_username',
    'Account email',
    kind: 'email',
    required: true,
  ),
  ConnectorField(
    'confluence_access_token',
    'API token',
    kind: 'secret',
    required: true,
    help: 'Encrypted on the server. Never read back or saved on this device.',
  ),
];
const confluenceScopeFields = [
  ConnectorField(
    'space',
    'Space key',
    help: 'Leave empty to read the whole site.',
  ),
  ConnectorField(
    'page_id',
    'Page ID',
    help: 'Optionally limit the source to one page.',
  ),
  ConnectorField(
    'index_recursively',
    'Include child pages',
    kind: 'boolean',
    initial: false,
  ),
];
const schedulePresets = <String, String>{
  '0 * * * *': 'Every hour',
  '0 */6 * * *': 'Every 6 hours',
  '0 2 * * *': 'Every day at 02:00',
};
String scheduleLabel(JsonMap? schedule) {
  if (schedule == null) return 'Manual sync only';
  final expression = textOf(schedule['cron_expression']);
  final label = schedule['schedule_type'] == 'interval'
      ? 'Every $expression seconds'
      : schedulePresets[expression] ?? expression;
  return '$label${schedule['enabled'] == true ? '' : ' · Paused'}';
}
