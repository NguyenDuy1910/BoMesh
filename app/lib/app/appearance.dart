import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Light, dark, or matching the phone; remembered on this device.
class AppearanceController extends ChangeNotifier {
  AppearanceController({SharedPreferencesAsync? preferences})
    : _preferences = preferences ?? SharedPreferencesAsync();

  static const _key = 'bomesh.appearance';
  final SharedPreferencesAsync _preferences;
  ThemeMode mode = ThemeMode.system;

  Future<void> restore() async {
    try {
      final stored = await _preferences.getString(_key);
      final restored = ThemeMode.values
          .where((value) => value.name == stored)
          .firstOrNull;
      if (restored != null && restored != mode) {
        mode = restored;
        notifyListeners();
      }
    } catch (_) {
      // Unavailable storage: keep matching the phone.
    }
  }

  Future<void> select(ThemeMode value) async {
    if (value == mode) return;
    mode = value;
    notifyListeners();
    try {
      await _preferences.setString(_key, value.name);
    } catch (_) {
      // The choice still applies for this visit.
    }
  }
}
