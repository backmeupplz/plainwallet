// Google's repository only for Google's and Android's groups, everything else from Maven Central; every artifact is
// checked against gradle/verification-metadata.xml (sha256), like package-lock.json's integrity hashes.
pluginManagement {
    repositories {
        google { content { includeGroupByRegex("com\\.android.*|androidx\\..*|com\\.google\\..*") } }
        mavenCentral()
    }
}
dependencyResolutionManagement {
    repositories {
        google { content { includeGroupByRegex("com\\.android.*|androidx\\..*|com\\.google\\..*") } }
        mavenCentral()
    }
}
rootProject.name = "plainwallet"
include(":app")
