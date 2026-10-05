import 'dart:convert';

import 'package:bomesh/app/app_theme.dart';
import 'package:bomesh/app/appearance.dart';
import 'package:bomesh/app/workspace_scope.dart';
import 'package:bomesh/core/api_client.dart';
import 'package:bomesh/features/auth/session.dart';
import 'package:bomesh/features/knowledge/collection_page.dart';
import 'package:bomesh/features/knowledge/document_page.dart';
import 'package:bomesh/features/knowledge/knowledge_models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';

const encrypted = 'The file is encrypted.';
const nothingLeft =
    'Nothing to process: the selected documents are already processed or being processed.';

Map<String, Object?> document(String id, String state) => {
  'id': id,
  'collection_id': 'collection',
  'name': '$id.pdf',
  'content_type': 'application/pdf',
  'size_bytes': 2048,
  'purpose': 'knowledge',
  'status': 'available',
  'processing': {
    'state': state,
    'error': state == 'failed' ? encrypted : null,
    'run_id': null,
  },
  'created_at': '2026-10-01T00:00:00Z',
  'updated_at': '2026-10-01T00:00:00Z',
};

/// A fake workspace: one collection holding a pending and a failed document.
/// It records every run request's body and answers run creation and run
/// reads in order.
class FakeWorkspace {
  FakeWorkspace({
    required this.collectionPermissions,
    required this.created,
    this.runStatuses = const [],
  });
  final List<String> collectionPermissions;
  final List<http.Response> created;
  final List<String> runStatuses;
  final runBodies = <Object?>[];
  var documentListReads = 0, runReads = 0;
  var states = {'pending': 'pending', 'failed': 'failed'};

  Map<String, Object?> get collection => {
    'id': 'collection',
    'title': 'Team handbook',
    'description': 'Policies and forms.',
    'parent_collection_id': null,
    'status': 'active',
    'document_count': states.length,
    'source_count': 0,
    'permissions': collectionPermissions,
  };

  http.Response json(Object value, [int status = 200]) =>
      http.Response(jsonEncode(value), status);

  late final api = ApiClient(
    baseUrl: 'http://api.test',
    client: MockClient((request) async {
      final path = request.url.path.replaceFirst('/api/v1', '');
      if (request.method == 'GET' && path == '/collections') {
        return json({
          'items': [collection],
          'total': 1,
        });
      }
      if (request.method == 'GET' && path == '/collections/collection') {
        return json(collection);
      }
      if (request.method == 'GET' && path == '/documents') {
        documentListReads++;
        return json({
          'items': [
            for (final MapEntry(:key, :value) in states.entries)
              document(key, value),
          ],
          'total': states.length,
        });
      }
      if (request.method == 'GET' && path.startsWith('/documents/')) {
        final id = path.split('/').last;
        return json(document(id, states[id]!));
      }
      if (request.method == 'GET' && path.startsWith('/knowledge/documents/')) {
        final id = path.split('/').last;
        return json({
          'document_id': id,
          'title': '$id.pdf',
          'content_type': 'application/pdf',
          'status': 'available',
          'preview': null,
          'elements': [
            {'element_id': 'p1', 'text': 'Section one of $id.', 'page': 1},
          ],
          'focus': null,
        });
      }
      if (request.method == 'POST' && path == '/ingestion-runs') {
        runBodies.add(jsonDecode(request.body));
        return created.removeAt(0);
      }
      if (request.method == 'GET' && path == '/ingestion-runs/run') {
        final status = runStatuses[runReads++];
        if (status == 'completed') {
          states = {for (final key in states.keys) key: 'ready'};
        }
        return json({'id': 'run', 'status': status});
      }
      return json({'detail': 'unexpected ${request.method} $path'}, 500);
    }),
  )..accessToken = 'token';

  Widget app(Widget page, {List<String> permissions = const []}) {
    final session = AuthSession.fromJson({
      'access_token': 'token',
      'session_id': 'session',
      'user_id': 'user',
      'active_workspace_id': 'workspace',
      'expires_at': DateTime.now()
          .add(const Duration(hours: 1))
          .toIso8601String(),
      'permissions': ['knowledge.read', ...permissions],
      'workspaces': [
        {'id': 'workspace', 'name': 'Workspace', 'code': 'workspace'},
      ],
    });
    return MaterialApp(
      theme: AppTheme.light,
      home: WorkspaceScope(
        api: api,
        session: session,
        auth: SessionController(api),
        appearance: AppearanceController(),
        askAboutDocument: (_, _) {},
        waitingRequests: 0,
        refreshWaitingRequests: () async {},
        child: page,
      ),
    );
  }

  Widget collectionPage({List<String> permissions = const []}) => app(
    CollectionPage(collection: KnowledgeCollection.fromJson(collection)),
    permissions: permissions,
  );

  Widget documentPage(String id, {List<String> permissions = const []}) =>
      app(DocumentPage(documentId: id), permissions: permissions);
}

/// A row's meta line ("PDF · 2 KB · Not searchable yet") is rich text.
Finder notSearchableRows() =>
    find.textContaining('Not searchable yet', findRichText: true);

void main() {
  setUp(
    () => SharedPreferencesAsyncPlatform.instance =
        InMemorySharedPreferencesAsync.empty(),
  );

  testWidgets(
    'a collection makes its pending and outdated items searchable and shows a 409 as the server says',
    (tester) async {
      final fake = FakeWorkspace(
        collectionPermissions: ['collection.read', 'ingestion.run'],
        created: [
          http.Response(jsonEncode({'detail': nothingLeft}), 409),
        ],
      );
      await tester.pumpWidget(fake.collectionPage());
      await tester.pumpAndSettle();
      expect(notSearchableRows(), findsNWidgets(2));
      // A collection run takes pending and outdated documents; the failed
      // one is retried on its own page.
      expect(find.text('1 item isn’t searchable yet'), findsOneWidget);

      await tester.tap(find.text('Make searchable'));
      await tester.pumpAndSettle();
      expect(fake.runBodies, [
        {
          'collection_id': 'collection',
          'states': ['pending', 'outdated'],
          'trigger': 'manual',
        },
      ]);
      expect(find.text(nothingLeft), findsOneWidget);
      // No run started and nothing is becoming searchable: no polling.
      expect(fake.documentListReads, 1);
      await tester.pumpWidget(const SizedBox.shrink());
      fake.api.close();
    },
  );

  testWidgets(
    'a document that is not searchable yet starts a run for itself and follows it until it finishes',
    (tester) async {
      final fake = FakeWorkspace(
        collectionPermissions: ['collection.read'],
        created: [
          http.Response(jsonEncode({'id': 'run', 'status': 'queued'}), 202),
        ],
        runStatuses: ['queued', 'completed'],
      );
      // Workspace-wide ingestion.run applies to every collection.
      await tester.pumpWidget(
        fake.documentPage('pending', permissions: ['ingestion.run']),
      );
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Not searchable yet — the assistant can’t use it until it is.',
        ),
        findsOneWidget,
      );
      expect(find.text('Ask about this document'), findsOneWidget);

      await tester.tap(find.text('Make searchable'));
      await tester.pumpAndSettle();
      expect(fake.runBodies, [
        {
          'document_ids': ['pending'],
          'trigger': 'manual',
        },
      ]);
      expect(find.textContaining('Becoming searchable'), findsOneWidget);
      expect(find.text('Make searchable'), findsNothing);

      // The run finishes: the page reads the document again and stops.
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      expect(fake.runReads, 2);
      expect(find.textContaining('Becoming searchable'), findsNothing);
      expect(find.textContaining('Not searchable yet'), findsNothing);
      await tester.pump(const Duration(seconds: 10));
      expect(fake.runReads, 2);
      await tester.pumpWidget(const SizedBox.shrink());
      fake.api.close();
    },
  );

  testWidgets('a failed document says why and offers to try again', (
    tester,
  ) async {
    final fake = FakeWorkspace(
      collectionPermissions: ['collection.read', 'ingestion.run'],
      created: [
        http.Response(jsonEncode({'detail': nothingLeft}), 409),
      ],
    );
    await tester.pumpWidget(fake.documentPage('failed'));
    await tester.pumpAndSettle();
    expect(
      find.text('It couldn’t be made searchable: $encrypted'),
      findsOneWidget,
    );
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(fake.runBodies, [
      {
        'document_ids': ['failed'],
        'trigger': 'manual',
      },
    ]);
    expect(find.text(nothingLeft), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    fake.api.close();
  });

  testWidgets('without ingestion.run nothing offers Make searchable', (
    tester,
  ) async {
    final fake = FakeWorkspace(
      collectionPermissions: ['collection.read', 'collection.update'],
      created: [],
    );
    await tester.pumpWidget(fake.collectionPage());
    await tester.pumpAndSettle();
    // Rows still say so; nothing offers to change it.
    expect(notSearchableRows(), findsNWidgets(2));
    expect(
      find.textContaining(RegExp('(isn’t|aren’t) searchable')),
      findsNothing,
    );
    expect(find.text('Make searchable'), findsNothing);

    await tester.pumpWidget(fake.documentPage('pending'));
    await tester.pumpAndSettle();
    expect(
      find.text('Not searchable yet — the assistant can’t use it until it is.'),
      findsOneWidget,
    );
    expect(find.text('Make searchable'), findsNothing);
    await tester.tap(find.byTooltip('More'));
    await tester.pumpAndSettle();
    expect(find.text('Delete'), findsOneWidget);
    expect(find.text('Make searchable'), findsNothing);

    await tester.pumpWidget(fake.documentPage('failed'));
    await tester.pumpAndSettle();
    expect(find.text('Try again'), findsNothing);
    expect(fake.runBodies, isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    fake.api.close();
  });
}
