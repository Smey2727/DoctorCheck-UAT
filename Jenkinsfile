pipeline {
    agent { label 'windows' }

    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '10'))
    }

    environment {
        CI = 'true'
        // Playwright is a devDependency and must be installed in this job.
        NODE_ENV = 'development'
        PLAYWRIGHT_HTML_OPEN = 'never'
    }

    stages {
        stage('Checkout UAT repository') {
            steps {
                // Uses the repository, main branch and credentials from the job.
                checkout scm
                // Prevent reports from an earlier build being published again.
                dir('test-results') { deleteDir() }
                dir('playwright-report') { deleteDir() }
            }
        }

        stage('Check tools') {
            steps {
                bat 'node --version'
                bat 'npm --version'
                bat 'git --version'
                bat 'python --version'
                bat 'python -m pip --version'
            }
        }

        stage('Install Node dependencies') {
            steps {
                bat 'npm ci'
            }
        }

        stage('Install Chromium') {
            steps {
                bat 'npx playwright install chromium'
            }
        }

        stage('Install PDF test dependency') {
            steps {
                // TC-HP-020 imports pypdf from this project-local directory.
                bat 'python -m pip install --upgrade --target .uat-tools/python -r tests/helpers/requirements-pdf.txt'
            }
        }

        stage('Run Playwright tests') {
            steps {
                // A nonzero exit code fails the build; do not hide test failures.
                bat 'npx playwright test'
            }
            post {
                always {
                    archiveArtifacts artifacts: 'playwright-report/**,test-results/**', allowEmptyArchive: true
                    junit testResults: 'test-results/junit.xml', allowEmptyResults: false, skipPublishingChecks: true
                }
            }
        }
    }
}
