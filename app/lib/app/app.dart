import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/api_client.dart';
import '../features/auth/auth_page.dart';
import '../features/auth/session.dart';
import 'app_brand.dart';
import 'app_theme.dart';
import 'workspace_shell.dart';

class ProductApp extends StatefulWidget {
  const ProductApp({super.key});

  @override
  State<ProductApp> createState() => _ProductAppState();
}

class _ProductAppState extends State<ProductApp> with WidgetsBindingObserver {
  static const _themeKey = 'bothesis-theme';
  final _preferences = SharedPreferencesAsync();
  ThemeMode _themeMode = ThemeMode.system;
  late final ApiClient _api;
  late final SessionController _auth;

  @override
  void initState() {
    super.initState();
    _loadTheme();
    _api = ApiClient();
    _auth = SessionController(_api);
    WidgetsBinding.instance.addObserver(this);
    unawaited(_auth.restore());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_auth.refresh().catchError((Object _) {}));
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _auth.dispose();
    _api.close();
    super.dispose();
  }

  Future<void> _loadTheme() async {
    final value = await _preferences.getString(_themeKey);
    if (!mounted) return;
    setState(() {
      _themeMode = switch (value) {
        'light' => ThemeMode.light,
        'dark' => ThemeMode.dark,
        _ => ThemeMode.system,
      };
    });
  }

  void _cycleTheme() {
    final next = switch (_themeMode) {
      ThemeMode.system => ThemeMode.light,
      ThemeMode.light => ThemeMode.dark,
      ThemeMode.dark => ThemeMode.system,
    };
    setState(() => _themeMode = next);
    _preferences.setString(_themeKey, next.name);
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: AppBrand.productName,
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: _themeMode,
      home: AnimatedBuilder(
        animation: _auth,
        builder: (context, _) {
          if (_auth.restoring) {
            return const Scaffold(
              body: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    CircularProgressIndicator(),
                    SizedBox(height: 20),
                    Text('Opening your workspace…'),
                  ],
                ),
              ),
            );
          }
          final session = _auth.session;
          return Navigator(
            key: ValueKey(
              session == null
                  ? 'signed-out'
                  : '${session.namespace}:${session.accessToken}',
            ),
            pages: [
              MaterialPage<void>(
                name: session == null ? '/sign-in' : '/workspace',
                child: session == null
                    ? AuthPage(controller: _auth)
                    : WorkspaceShell(
                        api: _api,
                        auth: _auth,
                        themeMode: _themeMode,
                        onCycleTheme: _cycleTheme,
                      ),
              ),
            ],
            onDidRemovePage: (_) {},
          );
        },
      ),
    );
  }
}
