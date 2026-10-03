import 'dart:convert';

import 'package:bomesh/app/app_theme.dart';
import 'package:bomesh/core/api_client.dart';
import 'package:bomesh/features/auth/auth_page.dart';
import 'package:bomesh/features/auth/session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'invalid form refuses submission and preserves visible field errors',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      var submitted = false;
      final api = ApiClient(
        client: MockClient((request) async {
          submitted = true;
          return http.Response('{}', 401, request: request);
        }),
      );
      final auth = SessionController(api);
      addTearDown(auth.dispose);
      addTearDown(api.close);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: AuthPage(controller: auth),
        ),
      );
      await tester.ensureVisible(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pump();
      expect(submitted, isFalse);
      expect(find.text('Enter your email or username.'), findsOneWidget);
      expect(find.text('Use at least 8 characters.'), findsOneWidget);
    },
  );

  testWidgets(
    'rejected credentials leave entered identifier available to correct',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      final api = ApiClient(
        client: MockClient(
          (request) async => http.Response(
            jsonEncode({
              'code': 'INVALID_CREDENTIALS',
              'message': 'Sign-in details are incorrect.',
            }),
            401,
            request: request,
          ),
        ),
      );
      final auth = SessionController(api);
      addTearDown(auth.dispose);
      addTearDown(api.close);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: AuthPage(controller: auth),
        ),
      );
      await tester.enterText(
        find.byType(TextFormField).at(0),
        'analyst@example.com',
      );
      await tester.enterText(
        find.byType(TextFormField).at(1),
        'wrong-password',
      );
      await tester.ensureVisible(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();
      expect(find.text('Sign-in details are incorrect.'), findsOneWidget);
      expect(find.text('analyst@example.com'), findsOneWidget);
      expect(auth.session, isNull);
    },
  );

  testWidgets(
    'authentication remains scrollable at phone landscape and enlarged text',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      final api = ApiClient();
      final auth = SessionController(api);
      addTearDown(auth.dispose);
      addTearDown(api.close);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      for (final size in [
        const Size(375, 667),
        const Size(667, 375),
        const Size(1024, 600),
      ]) {
        tester.view.physicalSize = size;
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.dark,
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(
                textScaler: const TextScaler.linear(2),
                disableAnimations: true,
              ),
              child: child!,
            ),
            home: AuthPage(controller: auth),
          ),
        );
        await tester.pumpAndSettle();
        await tester.ensureVisible(
          find.widgetWithText(
            TextButton,
            'New to BoMesh? Create an account',
          ),
        );
        await tester.pumpAndSettle();
      }
    },
  );
}
