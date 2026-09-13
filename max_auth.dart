// =================================================================
// MAX AUTH — вход через Google
// =================================================================
// Один тап при первом запуске (стандартный выбор Google-аккаунта),
// дальше — тихо, как обычная сессия. Личность привязана к Google-
// аккаунту человека, а не к установке приложения — переживает сброс
// телефона, переустановку, покупку нового устройства.
//
// Список разрешённых e-mail живёт на бэкенде (ALLOWED_EMAILS) — сам
// факт успешного Google-входа НЕ значит, что бэкенд пустит: если
// e-mail не в списке, backend ответит 403, это нормальный сценарий
// (посторонний человек раздобыл APK, вошёл своим Google-аккаунтом,
// получил отказ на уровне сервера).
//
// Требует: Firebase.initializeApp() уже вызван в main.dart, Google
// включён как провайдер в Firebase Console, SHA-1 приложения
// прописан в настройках проекта (см. FLUTTER_INTEGRATION.md).
// =================================================================

import 'package:firebase_auth/firebase_auth.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:flutter/foundation.dart';

class MaxAuth {
  static final MaxAuth instance = MaxAuth._init();
  MaxAuth._init();

  final GoogleSignIn _googleSignIn = GoogleSignIn(scopes: ['email']);

  /// Стрим для экрана-заглушки (auth_gate.dart) — показывает кнопку
  /// входа, пока пользователь не залогинен, и пропускает дальше,
  /// как только появился валидный FirebaseAuth.instance.currentUser.
  Stream<User?> get authStateChanges => FirebaseAuth.instance.authStateChanges();

  User? get currentUser => FirebaseAuth.instance.currentUser;

  /// Открывает системный выбор Google-аккаунта. Вызывать по нажатию
  /// кнопки "Войти через Google" — НЕ пытаться вызывать тихо/лениво,
  /// в отличие от прежнего анонимного входа: Google обязательно
  /// требует явного действия пользователя, это не обходится.
  Future<void> signInWithGoogle() async {
    final googleUser = await _googleSignIn.signIn();
    if (googleUser == null) {
      // Пользователь закрыл диалог выбора аккаунта — не ошибка,
      // просто остаёмся на экране входа.
      return;
    }

    final googleAuth = await googleUser.authentication;
    final credential = GoogleAuthProvider.credential(
      accessToken: googleAuth.accessToken,
      idToken: googleAuth.idToken,
    );

    try {
      await FirebaseAuth.instance.signInWithCredential(credential);
      debugPrint('🔐 MaxAuth: вход через Google, email=${FirebaseAuth.instance.currentUser?.email}');
    } catch (e) {
      debugPrint('🔐 MaxAuth: ошибка входа через Google: $e');
      rethrow;
    }
  }

  Future<void> signOut() async {
    await _googleSignIn.signOut();
    await FirebaseAuth.instance.signOut();
  }

  /// Возвращает свежий ID-токен текущего пользователя. Бросает
  /// исключение, если никто не залогинен — вызывающий код (AiService)
  /// не должен пытаться сам логинить, это забота auth_gate.dart,
  /// который не пускает дальше без сессии.
  Future<String> getIdToken() async {
    final user = currentUser;
    if (user == null) {
      throw Exception('MaxAuth: пользователь не залогинен');
    }
    final token = await user.getIdToken();
    if (token == null) {
      throw Exception('MaxAuth: не удалось получить ID-токен');
    }
    return token;
  }
}
