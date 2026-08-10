package workflows

import (
"time"
"go.temporal.io/sdk/workflow"
)

// UserOnboardingWorkflow orchestrates the complete user onboarding journey
func UserOnboardingWorkflow(ctx workflow.Context, userID string) error {
logger := workflow.GetLogger(ctx)
logger.Info("Starting user onboarding workflow", "userID", userID)

ao := workflow.ActivityOptions{
StartToCloseTimeout: 10 * time.Minute,
RetryPolicy: &workflow.RetryPolicy{
MaximumAttempts: 3,
},
}
ctx = workflow.WithActivityOptions(ctx, ao)

// Step 1: Create user record
err := workflow.ExecuteActivity(ctx, "CreateUserActivity", userID).Get(ctx, nil)
if err != nil {
return err
}

// Step 2: Send welcome email
err = workflow.ExecuteActivity(ctx, "SendWelcomeEmailActivity", userID).Get(ctx, nil)
if err != nil {
logger.Warn("Failed to send welcome email", "error", err)
}

// Step 3: Initialize user wallet
err = workflow.ExecuteActivity(ctx, "InitializeWalletActivity", userID).Get(ctx, nil)
if err != nil {
return err
}

// Step 4: Publish user.registered event
err = workflow.ExecuteActivity(ctx, "PublishKafkaEventActivity", "user.registered", userID).Get(ctx, nil)
if err != nil {
logger.Warn("Failed to publish Kafka event", "error", err)
}

logger.Info("User onboarding workflow completed", "userID", userID)
return nil
}

// PaymentSetupWorkflow handles payment method registration
func PaymentSetupWorkflow(ctx workflow.Context, userID string, paymentMethod string) error {
logger := workflow.GetLogger(ctx)
logger.Info("Starting payment setup workflow", "userID", userID)

ao := workflow.ActivityOptions{
StartToCloseTimeout: 5 * time.Minute,
}
ctx = workflow.WithActivityOptions(ctx, ao)

// Validate payment credentials
var valid bool
err := workflow.ExecuteActivity(ctx, "ValidatePaymentCredentialsActivity", paymentMethod).Get(ctx, &valid)
if err != nil || !valid {
return err
}

// Encrypt and store credentials
err = workflow.ExecuteActivity(ctx, "StorePaymentCredentialsActivity", userID, paymentMethod).Get(ctx, nil)
if err != nil {
return err
}

// Test transaction
err = workflow.ExecuteActivity(ctx, "TestPaymentTransactionActivity", userID).Get(ctx, nil)
if err != nil {
return err
}

return nil
}

// ContractSigningWorkflow handles contract selection and signing
func ContractSigningWorkflow(ctx workflow.Context, userID string, contractType string) error {
logger := workflow.GetLogger(ctx)
logger.Info("Starting contract signing workflow", "userID", userID)

ao := workflow.ActivityOptions{
StartToCloseTimeout: 10 * time.Minute,
}
ctx = workflow.WithActivityOptions(ctx, ao)

// Generate contract
var contractID string
err := workflow.ExecuteActivity(ctx, "GenerateContractActivity", userID, contractType).Get(ctx, &contractID)
if err != nil {
return err
}

// Verify biometric signature
err = workflow.ExecuteActivity(ctx, "VerifyBiometricSignatureActivity", userID).Get(ctx, nil)
if err != nil {
return err
}

// Activate contract
err = workflow.ExecuteActivity(ctx, "ActivateContractActivity", contractID).Get(ctx, nil)
if err != nil {
return err
}

// Publish contract.signed event
err = workflow.ExecuteActivity(ctx, "PublishKafkaEventActivity", "contract.signed", contractID).Get(ctx, nil)
if err != nil {
logger.Warn("Failed to publish Kafka event", "error", err)
}

return nil
}
