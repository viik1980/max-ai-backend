// =================================================================
// MAX AUTH — анонимная личность для бэкенда
// =================================================================
// Не экран логина, не UI. Тихий анонимный вход при первом обращении
// к AiService — водитель ничего не видит и не вводит.
// Каждый запрос к Railway-бэкенду несёт ID-токен этой личности —
// бэкенд проверяет подпись (см. server.js/checkFirebaseAuth) и знает,
// какой именно uid дёргает API. Токен живёт час, firebase_auth сам
// его обновляет — в отличие от захардкоженного секрета, красть тут
// особо нечего: свежий токен не поможет через час.
//
// Требует: Firebase.initializeApp() уже вызван в main.dart (см. README
// бэкенда / инструкцию — этот файл сам его НЕ вызывает).
// =================================================================

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';

class MaxAuth {
  static final MaxAuth instance = MaxAuth._init();
  MaxAuth._init();

  User? _user;

  /// Возвращает свежий ID-токен, при необходимости сначала тихо
  /// логинит анонимно. Вызывать перед КАЖДЫМ запросом к бэкенду —
  /// firebase_auth сам решит, нужно ли реально обновлять токен
  /// по сети, или отдать закэшированный (обновляет держит сам SDK).
  Future<String> getIdToken() async {
    _user ??= FirebaseAuth.instance.currentUser;

    if (_user == null) {
      try {
        final cred = await FirebaseAuth.instance.signInAnonymously();
        _user = cred.user;
        debugPrint('🔐 MaxAuth: анонимный вход, uid=${_user?.uid}');
      } catch (e) {
        debugPrint('🔐 MaxAuth: ошибка анонимного входа: $e');
        rethrow;
      }
    }

    final token = await _user!.getIdToken();
    if (token == null) {
      throw Exception('MaxAuth: не удалось получить ID-токен');
    }
    return token;
  }
}
