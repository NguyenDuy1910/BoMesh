import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api_client.dart';
import '../auth/session.dart';
import 'connection_models.dart';
import 'connection_widgets.dart';

class ConnectorFields extends StatelessWidget {
  const ConnectorFields({
    super.key,
    required this.fields,
    required this.values,
    required this.onChanged,
    this.enabled = true,
  });
  final List<ConnectorField> fields;
  final JsonMap values;
  final VoidCallback onChanged;
  final bool enabled;
  @override
  Widget build(BuildContext context) => Column(
    children: [
      for (final field in fields)
        Padding(
          padding: const EdgeInsets.only(bottom: 16),
          child: field.kind == 'boolean'
              ? SwitchListTile.adaptive(
                  contentPadding: EdgeInsets.zero,
                  title: Text(field.label),
                  subtitle: field.help == null ? null : Text(field.help!),
                  value: values[field.name] == true,
                  onChanged: enabled
                      ? (value) {
                          values[field.name] = value;
                          onChanged();
                        }
                      : null,
                )
              : TextFormField(
                  key: ValueKey(field.name),
                  initialValue: textOf(values[field.name]),
                  enabled: enabled,
                  obscureText: field.kind == 'secret',
                  autocorrect: false,
                  enableSuggestions: false,
                  keyboardType: field.kind == 'url'
                      ? TextInputType.url
                      : field.kind == 'email'
                      ? TextInputType.emailAddress
                      : TextInputType.text,
                  decoration: InputDecoration(
                    labelText: '${field.label}${field.required ? ' *' : ''}',
                    helperText: field.help,
                    helperMaxLines: 3,
                  ),
                  validator: (value) {
                    final text = value?.trim() ?? '';
                    if (field.required && text.isEmpty) {
                      return '${field.label} is required';
                    }
                    if (text.isNotEmpty && field.kind == 'url') {
                      final uri = Uri.tryParse(text);
                      if (uri == null ||
                          !const {'https', 'http'}.contains(uri.scheme) ||
                          uri.host.isEmpty) {
                        return 'Enter a complete http or https URL';
                      }
                    }
                    if (text.isNotEmpty &&
                        field.kind == 'email' &&
                        !text.contains('@')) {
                      return 'Enter the account email';
                    }
                    return null;
                  },
                  onChanged: (value) {
                    values[field.name] = value;
                    onChanged();
                  },
                ),
        ),
    ],
  );
}

JsonMap initialFieldValues(
  List<ConnectorField> fields, [
  JsonMap values = const {},
]) => {
  for (final field in fields) field.name: values[field.name] ?? field.initial,
};
JsonMap submitFields(List<ConnectorField> fields, JsonMap values) => {
  for (final field in fields)
    if (values[field.name] is bool ||
        textOf(values[field.name]).trim().isNotEmpty)
      field.name: values[field.name] is bool
          ? values[field.name]
          : textOf(values[field.name]).trim(),
};

class ConnectionEditorPage extends StatefulWidget {
  const ConnectionEditorPage({
    super.key,
    required this.api,
    required this.session,
    required this.provider,
    this.connection,
  });
  final ApiClient api;
  final AuthSession session;
  final ProviderInfo provider;
  final ConnectionRecord? connection;
  @override
  State<ConnectionEditorPage> createState() => _ConnectionEditorPageState();
}

class _ConnectionEditorPageState extends State<ConnectionEditorPage>
    with WidgetsBindingObserver {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _name;
  late final JsonMap _config;
  final JsonMap _credentials = initialFieldValues(confluenceCredentialFields);
  late String _owner;
  late bool _authorization;
  bool _busy = false,
      _waiting = false,
      _checking = false,
      _replaceCredentials = false,
      _editConfiguration = false;
  String? _error;
  ConnectionRecord? _saved;
  Map<String, String> _before = {};
  final Set<String> _matched = {};
  Timer? _timer;
  DateTime? _authorizationStarted;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _saved = widget.connection;
    _name = TextEditingController(
      text: widget.connection?.name ?? widget.provider.name,
    );
    _owner =
        widget.connection?.ownerType ??
        (widget.session.can('source.manage') ? 'workspace' : 'user');
    _config = initialFieldValues(
      confluenceConnectionFields,
      widget.connection?.config ?? {},
    );
    _authorization = widget.connection != null || widget.provider.canAuthorize;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    _name.dispose();
    _credentials.clear();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _timer?.cancel();
    if (state == AppLifecycleState.resumed && _waiting) {
      unawaited(_checkAuthorization());
    }
  }

  Future<List<ConnectionRecord>> _accounts() async {
    final records = <ConnectionRecord>[];
    var page = 1;
    while (mounted) {
      final result = ResourcePage(
        await widget.api.get(
          '/connections',
          query: {'page': page, 'page_size': 100},
        ),
        ConnectionRecord.new,
      );
      records.addAll(result.items);
      if (!result.hasNext) break;
      page++;
    }
    return records;
  }

  Future<void> _authorize() async {
    if (_busy || _waiting) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final before = await _accounts();
      if (!mounted) return;
      _before = {for (final account in before) account.id: account.connectedAt};
      final result = await widget.api.post(
        '/connections/authorizations',
        body: {
          'connector_key': widget.provider.key,
          'owner_type': _owner,
          if (_saved != null) 'connection_id': _saved!.id,
        },
      );
      if (!mounted) return;
      final url = Uri.tryParse(textOf(result['authorization_url']));
      if (url == null || url.scheme != 'https' || url.host.isEmpty) {
        throw StateError(
          'The provider returned an invalid authorization address.',
        );
      }
      if (!await launchUrl(url, mode: LaunchMode.externalApplication)) {
        throw StateError('The sign-in browser could not be opened. Try again.');
      }
      if (!mounted) return;
      setState(() {
        _waiting = true;
        _authorizationStarted = DateTime.now();
      });
      _queueCheck();
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _queueCheck() {
    _timer?.cancel();
    if (!_waiting || !mounted) return;
    if (WidgetsBinding.instance.lifecycleState != null &&
        WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed) {
      return;
    }
    if (_authorizationStarted != null &&
        DateTime.now().difference(_authorizationStarted!) >
            const Duration(minutes: 10)) {
      setState(() {
        _waiting = false;
        _error = 'Sign-in has not completed. You can start again, or return to Connections and refresh if you finished in the browser.';
      });
      return;
    }
    _timer = Timer(const Duration(seconds: 3), _checkAuthorization);
  }

  Future<void> _checkAuthorization() async {
    if (_checking || !_waiting || !mounted) return;
    _checking = true;
    try {
      final accounts = _saved == null
          ? await _accounts()
          : [
              ConnectionRecord(
                await widget.api.get(resourcePath('connections', _saved!.id)),
              ),
            ];
      if (!mounted || !_waiting) return;
      final changed = accounts
          .where(
            (account) =>
                account.connector == widget.provider.key &&
                account.ownerType == _owner &&
                account.status == 'connected' &&
                _before[account.id] != account.connectedAt,
          )
          .toList();
      if (changed.length == 1) {
        _waiting = false;
        Navigator.pop(context, changed.single);
        return;
      }
      setState(() {
        _matched
          ..clear()
          ..addAll(changed.map((account) => account.id));
        _error = changed.length > 1
            ? 'More than one account changed. Return to Connections and choose the account you authorized.'
            : null;
      });
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      _checking = false;
      _queueCheck();
    }
  }

  Future<void> _save() async {
    if (_busy || !_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final body = <String, dynamic>{'display_name': _name.text.trim()};
      final credentialsMode =
          widget.provider.hasCredentialForm &&
          (widget.connection == null
              ? !_authorization
              : _editConfiguration || _replaceCredentials);
      if (credentialsMode) {
        body['config'] = {
          ...?widget.connection?.config,
          ...submitFields(confluenceConnectionFields, _config),
        };
      }
      if (credentialsMode &&
          (widget.connection == null || _replaceCredentials)) {
        body['credentials'] = submitFields(
          confluenceCredentialFields,
          _credentials,
        );
      }
      if (_saved == null) {
        body.addAll({
          'connector_key': widget.provider.key,
          'owner_type': _owner,
        });
        _saved = ConnectionRecord(
          await widget.api.post('/connections', body: body),
        );
      } else {
        _saved = ConnectionRecord(
          await widget.api.patch(
            resourcePath('connections', _saved!.id),
            body: body,
          ),
        );
      }
      if (!mounted) return;
      if (credentialsMode) {
        final validation = await widget.api.post(
          '${resourcePath('connections', _saved!.id)}/validate',
        );
        if (validation['valid'] != true) {
          throw StateError(
            'The account could not be verified. Check the credentials and try again.',
          );
        }
      }
      if (!mounted) return;
      final saved = ConnectionRecord(
        await widget.api.get(resourcePath('connections', _saved!.id)),
      );
      if (mounted) Navigator.pop(context, saved);
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(
        widget.connection == null
            ? 'Connect ${widget.provider.name}'
            : 'Edit connection',
      ),
    ),
    body: IntegrationBody(
      children: [
        Text(
          'Connect once. Choose what to sync next.',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 8),
        const Text(
          'Your credentials stay on the server. Adding an account does not start an ingestion.',
        ),
        const SizedBox(height: 24),
        if (_error != null)
          IntegrationNotice(
            message: _error!,
            error: true,
            onRetry: _waiting ? _checkAuthorization : null,
          ),
        if (_waiting)
          IntegrationCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const LinearProgressIndicator(),
                const SizedBox(height: 20),
                Text(
                  'Finish signing in with ${widget.provider.providerName}',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                const Text(
                  'Complete consent in your browser, then return here. This screen checks the saved account; it never reads the provider token.',
                ),
                const SizedBox(height: 16),
                OutlinedButton.icon(
                  onPressed: _checking ? null : _checkAuthorization,
                  icon: const Icon(Icons.refresh),
                  label: const Text('I finished signing in'),
                ),
                TextButton(
                  onPressed: () {
                    _timer?.cancel();
                    setState(() => _waiting = false);
                  },
                  child: const Text('Stop waiting'),
                ),
                if (_matched.length > 1)
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Return to Connections'),
                  ),
              ],
            ),
          )
        else
          Form(
            key: _form,
            child: IntegrationCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextFormField(
                    controller: _name,
                    enabled: !_busy,
                    maxLength: 255,
                    decoration: const InputDecoration(
                      labelText: 'Connection name',
                    ),
                    validator: (value) => value == null || value.trim().isEmpty
                        ? 'Name this connection'
                        : null,
                  ),
                  if (widget.connection == null) ...[
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String>(
                      initialValue: _owner,
                      decoration: const InputDecoration(
                        labelText: 'Who owns this connection?',
                      ),
                      isExpanded: true,
                      items: [
                        const DropdownMenuItem(
                          value: 'user',
                          child: Text('My account'),
                        ),
                        if (widget.session.can('source.manage'))
                          const DropdownMenuItem(
                            value: 'workspace',
                            child: Text('Shared workspace account'),
                          ),
                      ],
                      onChanged: _busy || _saved != null
                          ? null
                          : (value) => setState(() => _owner = value!),
                    ),
                  ],
                  if (widget.provider.canAuthorize &&
                      widget.provider.hasCredentialForm &&
                      widget.connection == null) ...[
                    const SizedBox(height: 16),
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      value: _authorization,
                      onChanged: _busy || _saved != null
                          ? null
                          : (value) => setState(() => _authorization = value),
                      title: Text(
                        'Sign in with ${widget.provider.providerName}',
                      ),
                      subtitle: const Text(
                        'Turn off to enter an API token instead.',
                      ),
                    ),
                  ],
                  if (widget.connection != null &&
                      widget.provider.hasCredentialForm) ...[
                    const SizedBox(height: 16),
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      value: _editConfiguration,
                      onChanged: _busy
                          ? null
                          : (value) =>
                                setState(() => _editConfiguration = value),
                      title: const Text('Edit connection settings'),
                      subtitle: const Text(
                        'Change the site address or deployment type.',
                      ),
                    ),
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      value: _replaceCredentials,
                      onChanged: _busy
                          ? null
                          : (value) =>
                                setState(() => _replaceCredentials = value),
                      title: const Text('Replace API credentials'),
                      subtitle: const Text(
                        'Only for token-based connections. Browser-authorized accounts must reconnect in the browser.',
                      ),
                    ),
                  ],
                  if (widget.provider.hasCredentialForm &&
                      (widget.connection == null
                          ? !_authorization
                          : _editConfiguration || _replaceCredentials)) ...[
                    const SizedBox(height: 16),
                    ConnectorFields(
                      fields: confluenceConnectionFields,
                      values: _config,
                      enabled: !_busy,
                      onChanged: () {},
                    ),
                    if (widget.connection == null || _replaceCredentials)
                      ConnectorFields(
                        fields: confluenceCredentialFields,
                        values: _credentials,
                        enabled: !_busy,
                        onChanged: () {},
                      ),
                  ],
                  const SizedBox(height: 16),
                  if (_authorization && widget.connection == null)
                    FilledButton.icon(
                      onPressed: _busy ? null : _authorize,
                      icon: const Icon(Icons.open_in_browser),
                      label: Text(
                        _busy
                            ? 'Opening browser…'
                            : 'Sign in with ${widget.provider.providerName}',
                      ),
                    )
                  else
                    FilledButton.icon(
                      onPressed: _busy ? null : _save,
                      icon: const Icon(Icons.check),
                      label: Text(
                        _busy
                            ? 'Saving…'
                            : widget.connection == null
                            ? 'Connect and verify'
                            : 'Save changes',
                      ),
                    ),
                  if (widget.connection != null && widget.provider.canAuthorize)
                    OutlinedButton.icon(
                      onPressed: _busy ? null : _authorize,
                      icon: const Icon(Icons.open_in_browser),
                      label: const Text('Reconnect in browser'),
                    ),
                ],
              ),
            ),
          ),
      ],
    ),
  );
}

class ScheduleEditorPage extends StatefulWidget {
  const ScheduleEditorPage({
    super.key,
    required this.api,
    required this.sourceId,
    this.schedule,
  });
  final ApiClient api;
  final String sourceId;
  final JsonMap? schedule;
  @override
  State<ScheduleEditorPage> createState() => _ScheduleEditorPageState();
}

class _ScheduleEditorPageState extends State<ScheduleEditorPage> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _expression, _timezone;
  late String _type, _overlap;
  late bool _enabled;
  bool _busy = false;
  String? _error;
  @override
  void initState() {
    super.initState();
    _type = textOf(widget.schedule?['schedule_type'], 'cron');
    _overlap = textOf(widget.schedule?['overlap_policy'], 'skip');
    _enabled = widget.schedule?['enabled'] != false;
    _expression = TextEditingController(
      text: textOf(widget.schedule?['cron_expression'], '0 2 * * *'),
    );
    _timezone = TextEditingController(
      text: textOf(widget.schedule?['timezone'], 'UTC'),
    );
  }

  @override
  void dispose() {
    _expression.dispose();
    _timezone.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy || !_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.put(
        '${resourcePath('sources', widget.sourceId)}/schedule',
        body: {
          'schedule_type': _type,
          'cron_expression': _expression.text.trim(),
          'timezone': _type == 'cron' && _timezone.text.trim().isNotEmpty
              ? _timezone.text.trim()
              : null,
          'enabled': _enabled,
          'overlap_policy': _overlap,
        },
      );
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(
        widget.schedule == null ? 'Add sync schedule' : 'Edit sync schedule',
      ),
    ),
    body: IntegrationBody(
      children: [
        if (_error != null) IntegrationNotice(message: _error!, error: true),
        Form(
          key: _form,
          child: IntegrationCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                DropdownButtonFormField<String>(
                  initialValue: _type,
                  decoration: const InputDecoration(labelText: 'Schedule type'),
                  items: const [
                    DropdownMenuItem(
                      value: 'cron',
                      child: Text('Calendar schedule'),
                    ),
                    DropdownMenuItem(
                      value: 'interval',
                      child: Text('Fixed interval'),
                    ),
                  ],
                  onChanged: _busy
                      ? null
                      : (value) => setState(() {
                          _type = value!;
                          _expression.text = _type == 'interval'
                              ? '3600'
                              : '0 2 * * *';
                        }),
                ),
                const SizedBox(height: 16),
                if (_type == 'cron')
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final preset in schedulePresets.entries)
                          ActionChip(
                            label: Text(preset.value),
                            onPressed: _busy
                                ? null
                                : () => setState(
                                    () => _expression.text = preset.key,
                                  ),
                          ),
                      ],
                    ),
                  ),
                TextFormField(
                  controller: _expression,
                  enabled: !_busy,
                  keyboardType: _type == 'interval'
                      ? TextInputType.number
                      : TextInputType.text,
                  decoration: InputDecoration(
                    labelText: _type == 'interval'
                        ? 'Interval in seconds'
                        : 'Cron expression',
                    helperText: _type == 'interval'
                        ? 'A positive number of seconds.'
                        : 'Minute · hour · day · month · weekday',
                  ),
                  validator: (value) {
                    final text = value?.trim() ?? '';
                    if (text.isEmpty) return 'Enter the schedule';
                    if (_type == 'interval' && (int.tryParse(text) ?? 0) <= 0) {
                      return 'Enter a positive whole number';
                    }
                    return null;
                  },
                ),
                if (_type == 'cron') ...[
                  const SizedBox(height: 16),
                  TextFormField(
                    controller: _timezone,
                    enabled: !_busy,
                    decoration: const InputDecoration(
                      labelText: 'Time zone',
                      helperText: 'IANA name, for example Asia/Ho_Chi_Minh. Empty uses UTC.',
                    ),
                  ),
                ],
                const SizedBox(height: 16),
                DropdownButtonFormField<String>(
                  initialValue: _overlap,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'If a sync is still running',
                  ),
                  items: const [
                    DropdownMenuItem(
                      value: 'skip',
                      child: Text('Skip the next sync'),
                    ),
                    DropdownMenuItem(
                      value: 'queue',
                      child: Text('Queue the next sync'),
                    ),
                    DropdownMenuItem(
                      value: 'replace',
                      child: Text('Replace the running sync'),
                    ),
                  ],
                  onChanged: _busy
                      ? null
                      : (value) => setState(() => _overlap = value!),
                ),
                SwitchListTile.adaptive(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Schedule enabled'),
                  value: _enabled,
                  onChanged: _busy
                      ? null
                      : (value) => setState(() => _enabled = value),
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _busy ? null : _save,
                  child: Text(_busy ? 'Saving…' : 'Save schedule'),
                ),
              ],
            ),
          ),
        ),
      ],
    ),
  );
}

class ResourcePickerPage extends StatefulWidget {
  const ResourcePickerPage({
    super.key,
    required this.api,
    required this.connection,
  });
  final ApiClient api;
  final ConnectionRecord connection;
  @override
  State<ResourcePickerPage> createState() => _ResourcePickerPageState();
}

class _ResourcePickerPageState extends State<ResourcePickerPage> {
  final _search = TextEditingController();
  final List<ProviderResource> _trail = [];
  final Map<String, ProviderResource> _selected = {};
  List<ProviderResource> _resources = [];
  bool _busy = false;
  String? _error;
  int _generation = 0;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _generation++;
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await widget.api.get(
        '${resourcePath('connections', widget.connection.id)}/resources',
        query: {
          if (_trail.isNotEmpty) 'parent_id': _trail.last.id,
          if (_search.text.trim().isNotEmpty) 'search': _search.text.trim(),
        },
      );
      if (!mounted || generation != _generation) return;
      setState(
        () =>
            _resources = objectList(result['items'])
                .map(ProviderResource.new)
                .toList(),
      );
    } catch (error) {
      if (mounted && generation == _generation) {
        setState(() => _error = '$error');
      }
    } finally {
      if (mounted && generation == _generation) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Choose provider content')),
    bottomNavigationBar: SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: FilledButton.icon(
          onPressed: _selected.isEmpty
              ? null
              : () => Navigator.pop(context, _selected.values.toList()),
          icon: const Icon(Icons.check),
          label: Text(
            'Use ${_selected.length} selected ${_selected.length == 1 ? 'resource' : 'resources'}',
          ),
        ),
      ),
    ),
    body: IntegrationBody(
      onRefresh: _load,
      children: [
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            TextButton(
              onPressed: _busy
                  ? null
                  : () {
                      _trail.clear();
                      _search.clear();
                      unawaited(_load());
                    },
              child: const Text('All content'),
            ),
            for (var index = 0; index < _trail.length; index++)
              TextButton(
                onPressed: _busy
                    ? null
                    : () {
                        _trail.removeRange(index + 1, _trail.length);
                        _search.clear();
                        unawaited(_load());
                      },
                child: Text(_trail[index].name),
              ),
          ],
        ),
        TextField(
          controller: _search,
          textInputAction: TextInputAction.search,
          onSubmitted: (_) => _load(),
          decoration: InputDecoration(
            labelText: 'Search this location',
            prefixIcon: const Icon(Icons.search),
            suffixIcon: IconButton(
              tooltip: 'Search provider resources',
              onPressed: _busy ? null : _load,
              icon: const Icon(Icons.arrow_forward),
            ),
          ),
        ),
        const SizedBox(height: 16),
        if (_error != null)
          IntegrationNotice(message: _error!, error: true, onRetry: _load),
        if (_busy) const LinearProgressIndicator(),
        if (!_busy && _resources.isEmpty && _error == null)
          const IntegrationEmpty(
            title: 'No content here',
            message: 'Try another location or search term.',
            icon: Icons.folder_open_outlined,
          ),
        for (final resource in _resources)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: IntegrationCard(
              padding: const EdgeInsets.all(8),
              child: Row(
                children: [
                  Checkbox(
                    value: _selected.containsKey(resource.selectionKey),
                    semanticLabel: 'Select ${resource.name}',
                    onChanged: (selected) => setState(() {
                      if (selected == true) {
                        _selected[resource.selectionKey] = resource;
                      } else {
                        _selected.remove(resource.selectionKey);
                      }
                    }),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          resource.name,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        Text(
                          readable(resource.type),
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                  if (resource.hasChildren)
                    IconButton(
                      tooltip: 'Browse ${resource.name}',
                      onPressed: _busy
                          ? null
                          : () {
                              _trail.add(resource);
                              _search.clear();
                              unawaited(_load());
                            },
                      icon: const Icon(Icons.chevron_right),
                    ),
                ],
              ),
            ),
          ),
      ],
    ),
  );
}

class SourceEditorPage extends StatefulWidget {
  const SourceEditorPage({
    super.key,
    required this.api,
    required this.session,
    required this.connection,
    this.source,
  });
  final ApiClient api;
  final AuthSession session;
  final ConnectionRecord connection;
  final SourceRecord? source;
  @override
  State<SourceEditorPage> createState() => _SourceEditorPageState();
}

class _SourceEditorPageState extends State<SourceEditorPage> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _name;
  final _newCollection = TextEditingController();
  final _collectionSearch = TextEditingController();
  final JsonMap _scope = initialFieldValues(confluenceScopeFields);
  List<JsonMap> _collections = [];
  List<ProviderResource> _selected = [];
  final Map<String, String> _created = {};
  final Set<String> _scheduled = {};
  String? _manualSourceId;
  bool get _creationStarted => _created.isNotEmpty || _manualSourceId != null;
  String? _destination, _error;
  String _frequency = 'manual';
  bool _newDestination = false,
      _busy = false,
      _loadingCollections = false,
      _replaceScope = false;
  bool _collectionsNext = false;
  int _collectionsPage = 1;
  int _collectionRequest = 0;
  @override
  void initState() {
    super.initState();
    _name = TextEditingController(
      text: widget.source?.name ?? widget.connection.name,
    );
    if (widget.source == null) unawaited(_loadCollections());
  }

  @override
  void dispose() {
    _collectionRequest++;
    _name.dispose();
    _newCollection.dispose();
    _collectionSearch.dispose();
    super.dispose();
  }

  Future<void> _loadCollections({bool more = false}) async {
    final request = ++_collectionRequest;
    final page = more ? _collectionsPage + 1 : 1;
    setState(() {
      _loadingCollections = true;
      _error = null;
    });
    try {
      final result = ResourcePage(
        await widget.api.get(
          '/collections',
          query: {
            'page': page,
            'page_size': 50,
            if (_collectionSearch.text.trim().isNotEmpty)
              'search': _collectionSearch.text.trim(),
          },
        ),
        (value) => value,
      );
      if (!mounted || request != _collectionRequest) return;
      setState(() {
        _collections = [
          ...(more ? _collections : <JsonMap>[]),
          ...result.items.where((value) => value['status'] != 'archived'),
        ];
        _collectionsPage = page;
        _collectionsNext = result.hasNext;
      });
    } catch (error) {
      if (mounted && request == _collectionRequest) {
        setState(() => _error = '$error');
      }
    } finally {
      if (mounted && request == _collectionRequest) {
        setState(() => _loadingCollections = false);
      }
    }
  }

  Future<void> _pick() async {
    final selected = await Navigator.push<List<ProviderResource>>(
      context,
      MaterialPageRoute(
        builder: (_) =>
            ResourcePickerPage(api: widget.api, connection: widget.connection),
      ),
    );
    if (mounted && selected != null) setState(() => _selected = selected);
  }

  Future<void> _save() async {
    if (_busy || !_form.currentState!.validate()) return;
    if (widget.source == null &&
        widget.connection.browsable &&
        _selected.isEmpty) {
      setState(() => _error = 'Choose the provider content to sync.');
      return;
    }
    if (widget.source == null && !_newDestination && _destination == null) {
      setState(() => _error = 'Choose a destination collection.');
      return;
    }
    if (widget.source != null &&
        _replaceScope &&
        !await confirmIntegration(
          context,
          title: 'Replace source scope?',
          message: 'The API does not return the existing source configuration. These fields replace the entire scope and reset the sync cursor. Leave this off to keep the current scope.',
          action: 'Replace scope',
        )) {
      return;
    }
    if (!mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (widget.source != null) {
        await widget.api.patch(
          resourcePath('sources', widget.source!.id),
          body: {
            'display_name': _name.text.trim(),
            if (_replaceScope)
              'config': submitFields(confluenceScopeFields, _scope),
          },
        );
      } else {
        if (_newDestination && _destination == null) {
          final collection = await widget.api.post(
            '/collections',
            body: {'title': _newCollection.text.trim()},
          );
          _destination = textOf(collection['id']);
          if (!mounted) return;
        }
        final schedule = _frequency == 'manual'
            ? null
            : {
                'schedule_type': 'cron',
                'cron_expression': _frequency,
                'timezone': 'UTC',
                'enabled': true,
                'overlap_policy': 'skip',
              };
        final resources = widget.connection.browsable
            ? _selected
            : <ProviderResource>[];
        if (resources.isEmpty) {
          if (_manualSourceId == null) {
            final source = await widget.api.post(
              '${resourcePath('connections', widget.connection.id)}/sources',
              body: {
                'collection_id': _destination,
                'display_name': _name.text.trim(),
                'config': submitFields(confluenceScopeFields, _scope),
              },
            );
            _manualSourceId = textOf(source['id']);
          }
          if (!mounted) return;
          if (schedule != null) {
            await widget.api.put(
              '${resourcePath('sources', _manualSourceId!)}/schedule',
              body: schedule,
            );
          }
        } else {
          for (final resource in resources) {
            if (!mounted) return;
            if (!_created.containsKey(resource.selectionKey)) {
              final source = await widget.api.post(
                '${resourcePath('connections', widget.connection.id)}/sources',
                body: {
                  'collection_id': _destination,
                  'display_name': resources.length == 1
                      ? _name.text.trim()
                      : resource.name,
                  'resource_type': resource.type,
                  'external_resource_id': resource.id,
                },
              );
              _created[resource.selectionKey] = textOf(source['id']);
            }
            if (!mounted) return;
            if (schedule != null &&
                !_scheduled.contains(resource.selectionKey)) {
              await widget.api.put(
                '${resourcePath('sources', _created[resource.selectionKey]!)}/schedule',
                body: schedule,
              );
              _scheduled.add(resource.selectionKey);
            }
          }
        }
      }
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) {
        setState(
          () => _error =
              '${!_creationStarted ? '' : 'Created sources are saved. Retry continues unfinished source or schedule setup without recreating them.\n'}$error',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(
        widget.source == null
            ? 'Add knowledge source'
            : 'Edit knowledge source',
      ),
    ),
    body: IntegrationBody(
      children: [
        if (_error != null) IntegrationNotice(message: _error!, error: true),
        Form(
          key: _form,
          child: IntegrationCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextFormField(
                  controller: _name,
                  enabled: !_busy && !_creationStarted,
                  maxLength: 255,
                  decoration: const InputDecoration(labelText: 'Source name'),
                  validator: (value) => value == null || value.trim().isEmpty
                      ? 'Name this source'
                      : null,
                ),
                const SizedBox(height: 16),
                if (widget.source == null) ...[
                  if (widget.connection.browsable) ...[
                    OutlinedButton.icon(
                      onPressed: _busy || _creationStarted ? null : _pick,
                      icon: const Icon(Icons.folder_open_outlined),
                      label: Text(
                        _selected.isEmpty
                            ? 'Choose content from provider'
                            : '${_selected.length} resources selected',
                      ),
                    ),
                    for (final resource in _selected)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(
                          _created.containsKey(resource.selectionKey)
                              ? Icons.check_circle_outline
                              : Icons.folder_outlined,
                        ),
                        title: Text(resource.name),
                        subtitle: Text(readable(resource.type)),
                      ),
                  ] else if (widget.connection.connector == 'confluence')
                    ConnectorFields(
                      fields: confluenceScopeFields,
                      values: _scope,
                      enabled: !_busy && !_creationStarted,
                      onChanged: () {},
                    ),
                  const SizedBox(height: 24),
                  Text(
                    'Destination collection',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 8),
                  if (widget.session.can('item.manage'))
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Create a new collection'),
                      value: _newDestination,
                      onChanged: _busy || _creationStarted
                          ? null
                          : (value) => setState(() {
                              _newDestination = value;
                              _destination = null;
                            }),
                    ),
                  if (_newDestination)
                    TextFormField(
                      controller: _newCollection,
                      enabled: !_busy && _destination == null,
                      decoration: const InputDecoration(
                        labelText: 'New collection name',
                      ),
                      maxLength: 255,
                      validator: (value) =>
                          value == null || value.trim().isEmpty
                          ? 'Name the collection'
                          : null,
                    )
                  else ...[
                    TextField(
                      controller: _collectionSearch,
                      enabled: !_busy && _created.isEmpty,
                      textInputAction: TextInputAction.search,
                      onSubmitted: (_) => _loadCollections(),
                      decoration: InputDecoration(
                        labelText: 'Find a collection',
                        prefixIcon: const Icon(Icons.search),
                        suffixIcon: IconButton(
                          tooltip: 'Search collections',
                          onPressed: _loadingCollections || _busy
                              ? null
                              : () => _loadCollections(),
                          icon: const Icon(Icons.arrow_forward),
                        ),
                      ),
                    ),
                    if (_loadingCollections) const LinearProgressIndicator(),
                    for (final collection in _collections)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(
                          _destination == collection['id']
                              ? Icons.radio_button_checked
                              : Icons.radio_button_unchecked,
                        ),
                        title: Text(textOf(collection['title'])),
                        subtitle: Text(
                          '${countOf(collection['document_count'])} documents',
                        ),
                        onTap: _busy || _creationStarted
                            ? null
                            : () => setState(
                                () => _destination = textOf(collection['id']),
                              ),
                      ),
                    if (_collections.isEmpty && !_loadingCollections)
                      const Padding(
                        padding: EdgeInsets.all(16),
                        child: Text(
                          'No accessible collections found. Search again or create one if permitted.',
                        ),
                      ),
                    if (_collectionsNext)
                      TextButton(
                        onPressed: _loadingCollections || _busy
                            ? null
                            : () => _loadCollections(more: true),
                        child: const Text('Load more collections'),
                      ),
                    TextButton.icon(
                      onPressed: _loadingCollections || _busy
                          ? null
                          : () => _loadCollections(),
                      icon: const Icon(Icons.refresh),
                      label: const Text('Refresh collections'),
                    ),
                  ],
                  const SizedBox(height: 16),
                  DropdownButtonFormField<String>(
                    initialValue: _frequency,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'Sync frequency',
                    ),
                    items: [
                      const DropdownMenuItem(
                        value: 'manual',
                        child: Text('Only when I sync it'),
                      ),
                      for (final preset in schedulePresets.entries)
                        DropdownMenuItem(
                          value: preset.key,
                          child: Text('${preset.value} · UTC'),
                        ),
                    ],
                    onChanged: _busy || _creationStarted
                        ? null
                        : (value) => setState(() => _frequency = value!),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'Creating a source does not immediately run it. Use Sync now on its detail page, or let its schedule start it.',
                  ),
                ] else ...[
                  DetailLine(
                    'Destination collection',
                    widget.source!.collectionId,
                  ),
                  const Text(
                    'The destination is fixed for this source. To use another collection, remove this source and create a new one.',
                  ),
                  if (widget.connection.connector == 'confluence') ...[
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Replace provider scope'),
                      subtitle: const Text(
                        'Advanced: replaces the current scope and restarts discovery.',
                      ),
                      value: _replaceScope,
                      onChanged: _busy
                          ? null
                          : (value) => setState(() => _replaceScope = value),
                    ),
                    if (_replaceScope)
                      ConnectorFields(
                        fields: confluenceScopeFields,
                        values: _scope,
                        enabled: !_busy,
                        onChanged: () {},
                      ),
                  ],
                ],
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: _busy ? null : _save,
                  child: Text(
                    _busy
                        ? 'Saving…'
                        : widget.source == null
                        ? 'Create source'
                        : 'Save changes',
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    ),
  );
}
