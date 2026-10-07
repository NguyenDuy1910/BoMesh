import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum AppAccent {
  indigo('Indigo', Color(0xFF3B38C4), Color(0xFF6461F0)),
  teal('Teal', Color(0xFF0F766E), Color(0xFF14A394)),
  ocean('Ocean', Color(0xFF1D5FD6), Color(0xFF4A86F0)),
  plum('Plum', Color(0xFF8A3B84), Color(0xFFB25FAB)),
  graphite('Graphite', Color(0xFF1F2328), Color(0xFFC9CED6));

  const AppAccent(this.label, this.light, this.dark);
  final String label;
  final Color light, dark;
}

/// Light, dark, or matching the phone; remembered on this device.
class AppearanceController extends ChangeNotifier {
  AppearanceController({SharedPreferencesAsync? preferences})
    : _preferences = preferences ?? SharedPreferencesAsync();

  static const _key = 'bomesh.appearance';
  final SharedPreferencesAsync _preferences;
  ThemeMode mode = ThemeMode.system;
  AppAccent accent = AppAccent.indigo;

  Future<void> restore() async {
    try {
      final stored = await _preferences.getString(_key);
      final storedAccent = await _preferences.getString('$_key.accent');
      accent = AppAccent.values.where((value) => value.name == storedAccent).firstOrNull ?? AppAccent.indigo;
      final restored = ThemeMode.values
          .where((value) => value.name == stored)
          .firstOrNull;
      if (restored != null && restored != mode) {
        mode = restored;
      }
      notifyListeners();
    } catch (_) {
      // Unavailable storage: keep matching the phone.
    }
  }

  Future<void> selectAccent(AppAccent value) async {
    if (value == accent) return;
    accent = value;
    notifyListeners();
    try {
      await _preferences.setString('$_key.accent', value.name);
    } catch (_) {
      // Appearance still applies for this visit.
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
