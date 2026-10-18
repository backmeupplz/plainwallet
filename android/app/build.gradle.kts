plugins { id("com.android.application") version "9.4.1" }

val repo = rootDir.parentFile
val pkg = groovy.json.JsonSlurper().parse(repo.resolve("package.json")) as Map<*, *>
val version = pkg["version"] as String
// Literal in package.json so F-Droid's checkupdates can read it; it must stay major * 10000 + minor * 100 + patch.
val code = pkg["versionCode"] as Int
check(code == version.split(".").map(String::toInt).let { (major, minor, patch) -> major * 10000 + minor * 100 + patch }) { "package.json versionCode doesn't match version" }
// The wallet's web half: the extension's code, built for the app (entrypoints/android*).
val web = tasks.register<Exec>("web") {
    workingDir = repo
    commandLine("npm", "run", "build:android")
}
// F-Droid builds the web half in its prebuild step, before its scanner deletes npm's prebuilt build tools (-PprebuiltWeb).
tasks.named("preBuild") { if (!providers.gradleProperty("prebuiltWeb").isPresent) dependsOn(web) }

android {
    namespace = "com.borodutch.plainwallet"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.borodutch.plainwallet"
        minSdk = 30
        targetSdk = 36
        versionCode = code
        versionName = version
    }
    // Release builds come out unsigned: they're signed afterwards with apksigner, away from Gradle, its plugins and
    // the npm build (see README), so no build tool ever holds the release key or its password.
    sourceSets["main"].assets.srcDir(repo.resolve(".output/android-mv3"))
    // No encrypted dependency block in APKs: F-Droid rejects it. Play still gets it from the bundle.
    dependenciesInfo { includeInApk = false }
}

// For WebView's document-start scripts and web message listeners, which tell the app each page's real origin.
dependencies { implementation("androidx.webkit:webkit:1.17.1") }
