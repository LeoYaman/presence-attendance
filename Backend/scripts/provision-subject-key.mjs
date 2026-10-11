// Subject key provisioning moved out of the attendance application. Never open
// the attendance database or regenerate its retired shared-subject tables.
console.error('Subject keys are managed by SubjectRegistry. Use the provisioning command documented in SubjectRegistry/README.md.');
process.exitCode=1;
