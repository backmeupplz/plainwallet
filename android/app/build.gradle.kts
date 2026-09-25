plugins { id("com.android.application") version "9.4.1" }

val repo = rootDir.parentFile
val version = (groovy.json.JsonSlurper().parse(repo.resolve("package.json")) as Map<*, *>)["version"] as String
// Release signing, with a keystore kept outside the repo: PLAINWALLET_KEYSTORE (path, key alias "plainwallet") and
// PLAINWALLET_KEYSTORE_PASSWORD. Every release must use the same key, or it won't install over the last one.
val keystore = providers.environmentVariable("PLAINWALLET_KEYSTORE").orNull
// The wallet's web half: the extension's code, built for the app (entrypoints/android*).
val web = tasks.register<Exec>("web") {
    workingDir = repo
    commandLine("npm", "run", "build:android")
}
tasks.named("preBuild") { dependsOn(web) }

android {
    namespace = "com.github.backmeupplz.plainwallet"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.github.backmeupplz.plainwallet"
        minSdk = 30
        targetSdk = 36
        versionCode = version.split(".").map(String::toInt).let { (major, minor, patch) -> major * 10000 + minor * 100 + patch }
        versionName = version
    }
    if (keystore != null) {
        signingConfigs.create("release") {
            storeFile = file(keystore)
            storePassword = providers.environmentVariable("PLAINWALLET_KEYSTORE_PASSWORD").get()
            keyAlias = "plainwallet"
            keyPassword = storePassword
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("release")
    }
    sourceSets["main"].assets.srcDir(repo.resolve(".output/android-mv3"))
}

// For WebView's document-start scripts and web message listeners, which tell the app each page's real origin.
dependencies { implementation("androidx.webkit:webkit:1.17.1") }
