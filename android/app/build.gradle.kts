plugins { id("com.android.application") version "9.4.1" }

val repo = rootDir.parentFile
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
        versionCode = 1
        versionName = (groovy.json.JsonSlurper().parse(repo.resolve("package.json")) as Map<*, *>)["version"] as String
    }
    sourceSets["main"].assets.srcDir(repo.resolve(".output/android-mv3"))
}

// For WebView's document-start scripts and web message listeners, which tell the app each page's real origin.
dependencies { implementation("androidx.webkit:webkit:1.17.1") }
